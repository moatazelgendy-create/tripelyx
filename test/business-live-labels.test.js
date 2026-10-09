// Live price labels on every page (go-live design §5.5, §5.6, §8 row F): the seeded world of
// test/business-world.js on live prices (world({ live: true }): the demo providers moved into the live namespace
// by test/business-sandbox.js useLive, inventory status 'live'). A fixture over the demo data: nothing here is a
// live supplier, and nothing calls one.
//
// Every page every role of both companies reaches: every amount sits in a data-price-source="live" container that
// says "US dollars, from the airline · Priced at … · Can change until booked" (or the hotel supplier, or both),
// with no TEST DATA tag; the workspace ribbon is the live one; nothing says "Demo price", demo data, test data,
// "preview", "approved to book" or "real bookings", and no supplier is named. Then the request page in its
// states, the exports, the public pages, and a company Tripelyx has not confirmed yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, crawl, textOf, mainOf, Q } = require('./business-world');
const { assertSourceMoney } = require('./business-sandbox');
const { seedUser, seedOrg } = require('./business-helpers');
const { LIVE_RIBBON, NO_TRIPS, AWAITING_CONFIRMATION } = require('../server/views/business/parts');
const { APPROVED, WITHIN_DRAFT } = require('../server/views/business/request');
const { SEARCH_AFTER_CONFIRM, SOURCE_TOTALS } = require('../server/views/business/format');
const { SPENT_NO_SUPPLIER } = require('../server/views/business/budgets');
const { CSV_SOURCES_LIVE } = require('../server/views/business/reports');
const { NOTES } = require('../server/views/business/marketing');
const { SIGNUP_ACK } = require('../server/business/constants');

/** Words that never sit on a live page (go-live design §5.6). */
const NOT_LIVE = /Demo price|demo data|demo trip|\bdemo prices\b|TEST DATA|test data|not a real|\bpreview\b|approved to book|real bookings|Duffel|LiteAPI/i;

const workspaceSeeds = C => [
  C.B, `${C.B}/welcome`, `${C.B}/trips`, `${C.B}/trips?scope=team`, `${C.B}/trips?scope=all`, `${C.B}/trips/new`,
  `${C.B}/approvals`, `${C.B}/approvals?tab=decided`, `${C.B}/approvals?tab=company`, `${C.B}/approvals?tab=expired`,
  `${C.B}/policy`, `${C.B}/policies`, `${C.B}/budgets`, `${C.B}/reports`, `${C.B}/activity`, `${C.B}/settings`,
  `${C.B}/trips/search?from=CAI&to=LHR&depart=2026-11-12&return=2026-11-16&hotel=1&cabin=economy`,
  `${C.B}/trips/search?from=CAI&to=LHR&depart=2026-11-12&return=2026-11-16&hotel=1&cabin=business`,
  `${C.B}/trips/search?from=CAI&to=LHR&depart=2026-11-12&cabin=economy`,
];

/** A live page: the amounts, the words and (in a workspace) the ribbon. */
function checkLive(who) {
  return (url, res) => {
    if (res.status !== 200) return;
    const main = mainOf(res.text);
    const label = `${who} ${url}`;
    assertSourceMoney(main, 'live', { label });
    const text = textOf(res.text);
    const bad = text.match(NOT_LIVE);
    assert.equal(bad, null, `${label}: "${bad && text.slice(Math.max(0, bad.index - 80), bad.index + 80)}"`);
    assert.ok(!text.includes('—'), `${label}: no em dash`);
    if (url.startsWith('/business/o/')) assert.ok(text.includes(LIVE_RIBBON), `${label}: the live ribbon`);
  };
}

test('live prices on every page: every amount says US dollars, who priced it and that it can change until booked; no demo, test or preview words', async t => {
  const w = await world({ live: true });
  t.after(w.close);
  assert.equal(w.svc.inventory.status, 'live');
  let pages = 0;
  for (const C of [w.A, w.B]) {
    for (const [role, p] of Object.entries(C.people)) {
      const seen = await crawl(p.http, workspaceSeeds(C), { cap: 600, onPage: checkLive(`${C.word} ${role}`) });
      pages += seen.size;
    }
  }
  assert.ok(pages > 300, `crawled ${pages} pages`);

  // The request page in each state, as its traveler and as its decider.
  const emp = w.A.people.employee, mgr = w.A.people.manager;
  const within = await (async () => {
    const sv = await w.svc.searchTrip(emp.actor, Q);
    const pick = k => sv.legs[k].rows.find(r => r.row.available && r.evaluation.status === 'within').row.key;
    return w.svc.createRequest(emp.actor, { query: Q, selection: { out: pick('out'), back: pick('back'), hotel: null }, purpose: 'Acme live labels check' });
  })();
  const draft = textOf(mainOf((await emp.http.get(`${w.A.B}/trips/${within.id}`)).text));
  assert.ok(draft.includes(WITHIN_DRAFT.live), draft.slice(0, 600));
  assert.ok(draft.includes("This trip is inside your policy, so confirming approves it. Booking in Tripelyx isn't open yet, so nothing is booked or charged."));
  assert.ok(draft.includes('It is checked again before it is approved.'));
  assert.match(draft, /US dollars, from the airlines? · Priced at 12:00 PM, Fri 9 Oct \(Cairo time\) · Can change until booked/);

  const list = await w.svc.listRequests(w.A.people.owner.actor, { scope: 'all' });
  const byStatus = status => list.rows.find(r => r.status === status);
  const approved = byStatus('approved');
  assert.ok(approved, 'an approved request');
  const approvedText = textOf(mainOf((await w.A.people.owner.http.get(`${w.A.B}/trips/${approved.id}`)).text));
  assert.ok(approvedText.includes(textOf(String(APPROVED.live))), approvedText.slice(0, 600));
  assert.doesNotMatch(approvedText, /checked again before it is approved/, 'an approved trip is not checked again');

  const inbox = await w.svc.inbox(mgr.actor, { tab: 'waiting' });
  assert.ok(inbox.rows.length, 'something waits for the manager');
  const deciding = textOf(mainOf((await mgr.http.get(`${w.A.B}/trips/${inbox.rows[0].id}`)).text));
  assert.ok(deciding.includes('Your decision'), 'the decider panel');
  assert.ok(deciding.includes('It is checked again before it is approved.'));
  // The decider's price check (unchanged, or now and was) sits in a live container of its own.
  assert.match(deciding, /Price checked again at [^:]+:\d\d [AP]M today: (?:unchanged\.|now \$[\d,.]+ \(was \$[\d,.]+ ?\)\.[^·]*?) US dollars, from the airlines? and the hotel supplier · Priced at /);

  // The exports: the CSV says Supplier price on every row and the reports page says so; the company export's
  // note names supplier prices, never "preview".
  const reports = textOf(mainOf((await w.A.people.finance.http.get(`${w.A.B}/reports`)).text));
  assert.ok(reports.includes(CSV_SOURCES_LIVE), reports.slice(0, 600));
  assert.ok(reports.includes(SOURCE_TOTALS.live));
  const csv = await w.svc.exportCsv(w.A.people.finance.actor, {});
  const lines = csv.body.slice(1).split('\r\n').slice(1).filter(Boolean);
  assert.ok(lines.length > 0 && lines.every(l => l.startsWith('Supplier price,')), lines.slice(0, 2).join('\n'));
  const exported = JSON.parse((await w.svc.exportCompany(w.A.people.owner.actor)).json);
  assert.equal(exported.note, 'Tripelyx Business export. Amounts are whole US cents from supplier prices, as each request was priced. Nothing was booked or charged. Questions: go@tripelyx.com.');
  assert.ok(exported.requests.length > 0 && exported.requests.every(r => r.price_source === 'Supplier price'));

  // Budgets: Spent shows once booking is open.
  const budgets = textOf(mainOf((await w.A.people.finance.http.get(`${w.A.B}/budgets`)).text));
  assert.ok(budgets.includes(SPENT_NO_SUPPLIER));

  // The public pages: the live note, the live acknowledgement, no "Preview" eyebrow.
  const stranger = w.http('');
  const pub = textOf((await stranger.get('/business')).text);
  assert.ok(pub.includes(NOTES.live), pub.slice(0, 600));
  assert.doesNotMatch(pub, NOT_LIVE);
  const start = textOf(mainOf((await stranger.get('/business/start')).text));
  assert.ok(start.includes(SIGNUP_ACK.live.box));
  assert.ok(start.includes('Tripelyx confirms each new company before teammates can join and trip search opens.'));
  assert.doesNotMatch(start, NOT_LIVE);
});

test('live prices: a company Tripelyx has not confirmed sees when its search opens, and no way to start one', async t => {
  const w = await world({ live: true });
  t.after(w.close);
  const owner = await seedUser(w.app, { name: 'Blue Owner', email: 'blue.owner@blue.example' });
  const org = await seedOrg(w.app, owner, { status: 'pending', name: 'Blue Co' });
  const http = w.http(owner.cookie);
  const B = `/business/o/${org.id}`;
  const page = async url => {
    const res = await http.get(url);
    assert.equal(res.status, 200, url);
    checkLive('pending owner')(url, res);
    assert.ok(textOf(res.text).includes("Tripelyx is confirming Blue Co. You can set up policies, departments and budgets now. Teammates can join, and trip search opens, once it's confirmed."), `${url}: the pending ribbon`);
    return res;
  };
  const home = await page(B);
  assert.ok(textOf(mainOf(home.text)).includes(`Plan a work trip ${SEARCH_AFTER_CONFIRM}`));
  assert.ok(textOf(mainOf(home.text)).includes(`${NO_TRIPS.title} ${SEARCH_AFTER_CONFIRM}`));
  const form = await page(`${B}/trips/new`);
  assert.ok(textOf(mainOf(form.text)).includes(`${AWAITING_CONFIRMATION.title} ${SEARCH_AFTER_CONFIRM}`));
  assert.match(form.text, /<fieldset class="bz-search-fields" disabled>/);
  const trips = await page(`${B}/trips`);
  assert.ok(textOf(mainOf(trips.text)).includes(`${NO_TRIPS.title} ${SEARCH_AFTER_CONFIRM}`));
  const welcome = await page(`${B}/welcome`);
  assert.doesNotMatch(textOf(mainOf(welcome.text)), /Try a trip/);
  for (const res of [home, trips, welcome, await page(`${B}/policy`)]) {
    assert.doesNotMatch(mainOf(res.text), /href="[^"]*\/trips\/new/, 'no way to start a search');
  }
});
