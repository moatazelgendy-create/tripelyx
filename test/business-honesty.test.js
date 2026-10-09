// Honesty (plan §L Stage 3, A3): every Business page, as every role, says only what is true today. Demo
// inventory is labelled at every amount, nothing claims a trip was booked, reserved, ticketed, issued, paid,
// charged or emailed, no page pushes with urgency or scarcity, and no supplier, rating, review or internal
// field reaches the HTML, the CSV or the company export. With no supplier (production) the pages, the CSV and
// the export show the company's own figures only, and nothing says "demo", "test data" or "supplier prices".
//
// The seeded world (test/business-world.js) has two companies with every role, requests in many states (a
// swap that saved money, approvals by a manager and by an owner's override, a trip that departed, drafts sent
// back as unavailable or with new terms, a blocked draft, an approval over budget and a pending trip over
// budget, a decider's live check that finds a new price), a pending invite, budgets and newer policy
// versions. On top of it, Acme has a trip planned three days ahead, so the "Top reasons" tiles name the
// advance rule. Pages are crawled from every role's home (GET links only, so the crawl must write nothing),
// and every POST's refusal page (a stale rev, a gone option, a short note, a missing choice, a bad amount) is
// drawn and checked the same way.
//
// Words a reader sees are checked after the honest negations are written out ("Nothing was booked or
// charged.", "We don't send email yet."), so only a claim is left to fail.
//
// The worlds here use the MemoryStore (what a page says does not depend on the store, and the "writes
// nothing" checks compare its whole content); test/business-isolation.test.js runs the store checks on
// PostgresStore too when TEST_DATABASE_URL is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { world, trips, keyWhere, Q, REASON, textOf, mainOf, crawl } = require('./business-world');
const { storeSnapshot } = require('./business-helpers');
const tokens = require('../server/business/tokens');
const roles = require('../server/business/roles');
const { KINDS } = require('../server/business/constants');
const { money } = require('../server/views/business/format');

// The experience engine's pressure list, read from the one place it lives, so the two never drift apart.
const PRESSURE = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'experience-pages.test.js'), 'utf8');
  const m = /^const PRESSURE = \/(.+)\/([a-z]*);$/m.exec(src);
  assert.ok(m, 'the PRESSURE list of test/experience-pages.test.js');
  return new RegExp(m[1], m[2]);
})();
const EM_DASH = /\u2014|&mdash;|&#8212;|&#x2014;|\\2014/i;
/** The main site's environment notice (its layout, not Business copy), the only part of a page left out of the em dash check. */
const withoutEnvBanner = page => String(page).replace(/<aside class="env-banner"[\s\S]*?<\/aside>/g, '');

/** The honest sentences that name what does not happen (or a rule for later), written out before the checks. */
const HONEST = [
  /\bnothing (?:is|was|has been) (?:booked or charged|booked|charged)(?: yet)?/gi,
  /\bno emails are sent\b/gi,
  /\bwe don't send emails? yet\b/gi,
  // What is coming (plan §L Reports and the marketing page's "Coming next"), each marked Coming soon.
  /\bSpend booked Coming soon Shows once trips are booked through Tripelyx\./g,
  /\bReports on booked spend Coming soon\b/g,
  // A hotel rate's own cancellation terms, and what the trip total is made of.
  /\bAfter that \d+% of the total is charged\./g,
  /\bThe total is everything charged for these options\b/g,
  // The main site's copyright line, in the footer of the public pages.
  /\bAll rights reserved\./g,
];
/** Claims and words no Business page uses (the plan's list, plus what a booking would leave behind). */
const CLAIMS = [
  ['booked', /\bbooked\b|\bbooking (?:is )?confirmed\b/i],
  ['charged', /\bcharged\b|\bcharge (?:was|has been) made\b/i],
  ['emailed', /\bemailed\b|\bemails? (?:was |were |has been |have been |is |are )?sent\b|\bsent (?:you |them |him |her )?(?:an? )?emails?\b/i],
  ['ticket', /\b(?:e-?)?ticket(?:s|ed|ing)?\b/i],
  ['PNR', /\bPNRs?\b|\bbooking reference\b|\bconfirmation (?:number|code)\b|\brecord locator\b/i],
  ['Sold out', /\bsold out\b/i],
  ['reserved', /\breserv\w*/i],
  ['paid', /\bpaid\b/i],
  ['purchased', /\bpurchas\w*/i],
  ['issued', /\bissued\b/i],
  ['notified', /\bnotified\b/i],
  ['invite sent', /\binvit(?:e|es|ation|ations) (?:was |were |has been |have been |is |are )?sent\b/i],
  // Made-up scarcity: seat or room counts, "a few left", demand.
  ['scarcity', /\b\d+\s+(?:seats?|rooms?|places?|spots?)\s+(?:left|available)\b|\b(?:only )?a few (?:seats?|rooms?) left\b|\bleft at this price\b|\bin (?:high )?demand\b|\bselling fast\b|\bpopular choice\b/i],
  ['reviews', /\breviews\b|\b\d[\d,.]*\s*(?:reviews?|ratings?)\b|\brated\b|\bratings?\b|\b\d(?:\.\d)?\s*(?:\/\s*5|out of 5)\b/i],
  ['pressure', PRESSURE],
];
/**
 * No supplier, provider, rating or internal field in the markup (attributes, data and scripts included). A
 * `source` key is a supplier's unless it is a policy cap's (types.js FlightCap and HotelCap: the rule that set
 * the cap), which the company export carries in each request's evaluation.
 */
const MARKUP = /BusinessDemo|Mock\w*Provider|\bproviders?\b|\bsupplier(?:QuoteRef|Ref)\b|commission\w*|markup\w*|\bnet[A-Z]\w*|typicalNet\w*|["'](?:internal|provider|score)["']\s*:|["']source["']\s*:(?!\s*["'](?:route|fixed|median_pct|median_plus|fallback|none|city|country|default)["'])|data-(?:internal|score|source)\b|\bduffel\b|\bamadeus\b|\bsabre\b|\btravelport\b|\bexpedia\b|booking\.com|\bhotelbeds\b|\bskyscanner\b|kiwi\.com|\bagoda\b|\bpriceline\b|\btripadvisor\b|data-(?:rating|reviews?|remaining|provider|stock)\b|["'](?:rating|reviewCount|reviews|provider|remaining|seatsLeft|roomsLeft)["']\s*:/i;

/** The words of a page a reader meets: its text and the attributes read out or shown (titles, labels, alt). */
function wordsOf(page) {
  const attrs = [...String(page).matchAll(/\s(?:aria-label|title|alt|placeholder|content)="([^"]*)"/g)].map(m => textOf(m[1]));
  return `${textOf(page)} ${attrs.join(' . ')}`;
}
/**
 * `remaining` exists in Business only as the budget column (plan §B6: Budget, Committed, Awaiting approval,
 * Remaining). Anywhere else (a seat or room count, a data field) it is the scarcity the DTO strips.
 */
function withoutBudgetColumn(page) {
  return String(page).replace(/<th scope="col" class="is-num">Remaining<\/th>/g, '').replace(/<span class="bz-cell-label">Remaining<\/span>/g, '');
}

/** The checks every Business page passes, in any config. */
function assertHonest(label, page) {
  const s = String(page);
  let words = wordsOf(s);
  for (const re of HONEST) words = words.replace(re, ' ');
  for (const [name, re] of CLAIMS) {
    const m = re.exec(words);
    assert.ok(!m, `${label}: says "${m && m[0]}" (${name}): ${m && words.slice(Math.max(0, m.index - 100), m.index + 80)}`);
  }
  // "confirmed" is about the company only (Tripelyx confirms a company's name); a trip is never confirmed.
  for (const m of words.matchAll(/[^.!?]*\bconfirmed\b[^.!?]*/gi)) {
    assert.match(m[0], /\b(?:company|name|Tripelyx|join)\b/i, `${label}: "confirmed" about a company: ${m[0].trim()}`);
    assert.doesNotMatch(m[0], /\b(?:trips?|flights?|hotels?|rooms?|seats?|fares?|bookings?|reservations?)\b/i, `${label}: "confirmed" about a trip: ${m[0].trim()}`);
  }
  const markup = withoutBudgetColumn(s);
  const rem = /remaining/i.exec(markup);
  assert.ok(!rem, `${label}: "remaining" outside the budget column: ${rem && markup.slice(Math.max(0, rem.index - 120), rem.index + 60)}`);
  const leak = MARKUP.exec(s);
  assert.ok(!leak, `${label}: "${leak && leak[0]}" in the markup: ${leak && s.slice(Math.max(0, leak.index - 120), leak.index + 60)}`);
  assert.ok(!/\sstyle="/.test(s), `${label}: inline style`);
  assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(s), `${label}: inline script`);
  // The whole document (title, shell, attributes): only the main site's environment notice is left out.
  const dash = EM_DASH.exec(withoutEnvBanner(s));
  assert.ok(!dash, `${label}: an em dash: ${dash && withoutEnvBanner(s).slice(Math.max(0, dash.index - 120), dash.index + 40)}`);
}

/** The checks for a download (the CSV, the company export): claims, scarcity, markup and em dashes. */
function assertHonestText(label, text) {
  let words = String(text);
  for (const re of HONEST) words = words.replace(re, ' ');
  for (const [name, re] of CLAIMS) {
    const m = re.exec(words);
    assert.ok(!m, `${label}: says "${m && m[0]}" (${name}): ${m && words.slice(Math.max(0, m.index - 100), m.index + 80)}`);
  }
  const leak = MARKUP.exec(text);
  assert.ok(!leak, `${label}: "${leak && leak[0]}": ${leak && text.slice(Math.max(0, leak.index - 120), leak.index + 60)}`);
  assert.doesNotMatch(text, EM_DASH, `${label}: no em dash`);
}

/** A page with its <main> (and the main site's environment notice) cut out: the shell, header and footer. */
const outsideMain = page => withoutEnvBanner(page).replace(/<main\b[\s\S]*<\/main>/, '');
/**
 * No amount outside <main> on a page drawn in the Business shell (its top bar, switcher, nav and footer):
 * every amount sits in the page's own content. Pages in the main site's layout (the public Business pages,
 * the plain 404 a non-member gets) carry the consumer site's own header. Returns whether the page was checked.
 */
function assertNoAmountOutsideMain(label, page) {
  if (!/<body class="bz-app\b/.test(page)) return false;
  const words = wordsOf(outsideMain(page));
  const m = /[$€£¥]\s?\d/.exec(words);
  assert.ok(!m, `${label}: an amount outside <main>: ${m && words.slice(Math.max(0, m.index - 80), m.index + 40)}`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Amounts: every one in a demo container (demo), none in one (production)

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
const hasClass = (el, cls) => new RegExp(`\\bclass="[^"]*\\b${cls}\\b`).test(el.attrs);
const AMOUNT = /[$€£¥]\s?\d[\d,]*(?:\.\d+)?/g;

/**
 * Every amount of a page's <main> (a .bz-money, or an amount in text) and the container that labels it:
 * [{ what, box }], box the nearest data-price-source="demo" ancestor or null.
 */
function amountsOf(main) {
  const s = String(main);
  const all = elements(s);
  const boxOf = el => {
    let box = el;
    while (box && !/\bdata-price-source="demo"/.test(box.attrs)) box = box.parent;
    return box ? textOf(s.slice(box.inner, box.end)) : null;
  };
  const out = [];
  for (const el of all) if (hasClass(el, 'bz-money')) out.push({ what: textOf(s.slice(el.inner, el.end)), box: boxOf(el.parent) });
  for (const m of s.matchAll(/>([^<]+)</g)) {
    const text = textOf(m[1]);
    if (!/[$€£¥]\s?\d/.test(text)) continue;
    const at = m.index + 1;
    const owner = all.filter(el => !VOID.has(el.tag) && !/\/\s*$/.test(el.attrs) && el.inner <= at && at < el.end)
      .reduce((a, el) => (!a || el.inner > a.inner ? el : a), null);
    out.push({ what: text, box: boxOf(owner) });
  }
  return out;
}

/** Demo config: every amount sits in a container that says "Demo price"; on a trip's own page also "Priced at". */
function assertDemoAmounts(label, page, { priced }) {
  const found = amountsOf(mainOf(page));
  for (const { what, box } of found) {
    assert.ok(box !== null, `${label}: "${what.slice(0, 80)}" sits in a demo-price container`);
    assert.match(box, /Demo price/, `${label}: the container of "${what.slice(0, 60)}" says Demo price: ${box.slice(0, 160)}`);
    if (priced) assert.match(box, /Priced at/, `${label}: the container of "${what.slice(0, 60)}" says when it was priced: ${box.slice(0, 160)}`);
  }
  return found.length;
}

const centsOf = s => {
  const [whole, frac = ''] = s.replace(/^[$€£¥]\s?/, '').replace(/,/g, '').split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
};

// ---------------------------------------------------------------------------------------------------------
// What to crawl

const REQUEST_OK = ['swapped', 'auto_approved', 'submitted', 'repriced', 'cancelled', 'approved', 'denied', 'returned', 'message'];
const ADMIN_OK = [
  ['policies', 'handling'], ['policies/standard', 'saved'], ['policies/standard', 'unchanged'], ['budgets', 'budget'],
  ['people', 'revoked'], ['people', 'member'], ['people', 'removed'], ['people', 'department'], ['people', 'archived'],
  ['settings', 'saved'], ['settings', 'renamed'], ['approvals', 'returned'],
];

/**
 * The start pages of a crawl in company C: home, filtered lists, the welcome checklist (nothing links to it),
 * a trip search (in production the "Supplier not connected yet" page), every notice, and the shell 404.
 */
function seedsFor(C, extraRequests = []) {
  const urls = [
    C.B, `${C.B}/trips?scope=all`, `${C.B}/trips?scope=team`, `${C.B}/approvals?tab=decided`, `${C.B}/activity?group=trips`,
    `${C.B}/reports?period=2026-Q4`, `${C.B}/budgets?period=2026-Q4`, `${C.B}/trips/btr_ZZZZZZZZZZZZZZZZ`, '/business/app',
    `${C.B}/welcome`, `${C.B}/trips/search?${new URLSearchParams(Q)}`,
  ];
  for (const [page, code] of ADMIN_OK) urls.push(`${C.B}/${page}?ok=${code}`);
  for (const r of [...Object.values(C.requests), ...extraRequests]) for (const code of REQUEST_OK) urls.push(`${C.B}/trips/${r.id}?ok=${code}`);
  return urls;
}

const isHtml = res => /text\/html/.test(res.headers.get('content-type') || '');
/** A crawled URL as its route: ids written as their prefix, no query. */
const routeOf = url => url.replace(/\?.*$/, '').replace(/(org|btr|usr|inv)_[A-Za-z0-9_-]{16}/g, '$1');
const add = (map, k, n) => map.set(k, (map.get(k) || 0) + n);

/**
 * Crawl as everyone: each role of both companies, Pat Both, the platform admin and a stranger. `check(page)`
 * runs on each page as it arrives ({ who, url, res }). Every request is a GET, so the store must come out
 * of the crawl exactly as it went in.
 * @returns {Promise<number>} pages fetched
 */
async function crawlEveryone(w, extra, check) {
  const before = storeSnapshot(w.app);
  let n = 0;
  const each = who => (url, res) => { n += 1; check({ who, url, res }); };
  for (const C of [w.A, w.B]) {
    for (const [role, p] of Object.entries(C.people)) await crawl(p.http, seedsFor(C, extra[C.word] || []), { cap: 600, onPage: each(`${C.word} ${role}`) });
  }
  const publicUrls = ['/business', '/business/start', '/business/signin', '/business/app', `/business/invite/${w.A.invite.token}`, `/business/invite/${tokens.newToken()}`];
  for (const [who, h] of [['stranger', w.http('')], ['Pat Both', w.both.http], ['platform admin', w.ops.http]]) {
    await crawl(h, [...publicUrls, w.A.B, w.B.B], { cap: 600, onPage: each(who) });
  }
  for (const url of ['/admin/business', `/admin/business?ok=active&org=${w.A.id}`, `/admin/business?ok=suspended&org=${w.B.id}`]) {
    each('platform admin')(url, await w.ops.http.get(url));
  }
  assert.equal(storeSnapshot(w.app), before, 'the crawl (GETs only) wrote nothing');
  return n;
}

/** A trip three days ahead (the Standard policy asks for seven), sent for approval: Top reasons names that rule. */
async function lateTrip(w, C) {
  const emp = C.people.employee.actor;
  const q = { ...Q, depart: '2026-10-12', return: '2026-10-15' };
  const sv = await w.svc.searchTrip(emp, q);
  const row = r => r.row.available && r.row.carrier.code === 'ZA';
  const created = await w.svc.createRequest(emp, {
    query: q, purpose: `${C.word} late visit`,
    selection: { out: keyWhere(sv, 'out', row), back: keyWhere(sv, 'back', row), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 3) },
  });
  const sent = await w.svc.submit(emp, created.id, { rev: created.rev, reason: REASON, category: 'client_meeting' });
  assert.ok((sent.request.evaluation.violations || []).some(v => v.rule === 'flight.advance'), 'the late trip breaks the advance rule');
  return sent.request;
}

/** The pages each kind of workspace page is reached at, as the roles that see it (both configs). */
const WORKSPACE = ['/business/o/org', '/business/o/org/trips', '/business/o/org/trips/new', '/business/o/org/approvals', '/business/o/org/policy',
  '/business/o/org/policies', '/business/o/org/policies/standard', '/business/o/org/policies/standard/history', '/business/o/org/budgets',
  '/business/o/org/people', '/business/o/org/reports', '/business/o/org/activity', '/business/o/org/settings', '/business/o/org/welcome',
  '/business', '/business/start', '/business/signin', '/business/app', '/admin/business'];

/** Each amount of company C's demo page `page` equal to `amount` sits in a container that says Demo price. */
function assertBoxed(label, page, amount) {
  const hits = amountsOf(mainOf(page)).filter(x => x.what.includes(amount));
  assert.ok(hits.length > 0, `${label}: ${amount} is on the page`);
  for (const { what, box } of hits) assert.match(box || '', /Demo price/, `${label}: "${what.slice(0, 60)}" sits in a Demo price container`);
}

// ---------------------------------------------------------------------------------------------------------
// Production: the company's own figures

/** The company's own figures (production): budgets, zero, and every amount of every policy tier. */
async function companyFigures(w) {
  const allowed = new Set([0]);
  for (const C of [w.A, w.B]) {
    for (const b of C.budgets) allowed.add(b.amountCents);
    for (const tier of ['standard', 'director', 'executive']) {
      const pol = await w.svc.getPolicy(C.people.owner.actor, tier);
      for (const [k, v] of Object.entries(pol.form)) {
        if (typeof v === 'string' && /^\d+$/.test(v) && !/Days|Minutes|Pct|Stops|Stars/i.test(k)) allowed.add(Number(v) * 100);
      }
    }
  }
  return allowed;
}

/**
 * The words and marks of a supplier price source (round 1: 'sandbox' is supplier test data, 'live' supplier
 * prices). With no supplier connected no page, CSV or export carries any of them: the figures are the
 * company's own, so nothing may call them test data or supplier prices. ("Supplier not connected yet", the
 * trip search's answer in production, is not one of them.)
 */
const SUPPLIER_SOURCE_WORDS = /test data|\bsandbox\b|supplier test|Supplier price|test system/i;
const SUPPLIER_SOURCE_MARKS = /bz-price-test|bz-test-tag|bz-ribbon-test|data-price-source/i;

/**
 * Production: nothing says demo or supplier test data, no price label of any source, and every amount in
 * <main> is a company figure. Returns the amounts.
 */
function assertProductionPage(label, page, allowed) {
  const words = wordsOf(page);
  const demo = /\bdemo\b/i.exec(words);
  assert.ok(!demo, `${label}: says "demo" with no supplier: ${demo && words.slice(Math.max(0, demo.index - 120), demo.index + 60)}`);
  assert.doesNotMatch(page, /data-price-source="demo"|Demo price|Priced at/i, `${label}: no demo price label`);
  const named = SUPPLIER_SOURCE_WORDS.exec(words);
  assert.ok(!named, `${label}: names a supplier price source with no supplier: ${named && words.slice(Math.max(0, named.index - 120), named.index + 60)}`);
  const markup = String(page).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assert.doesNotMatch(markup, SUPPLIER_SOURCE_WORDS, `${label}: no supplier price source in the markup`);
  assert.doesNotMatch(markup, SUPPLIER_SOURCE_MARKS, `${label}: no price source container or test data tag`);
  let n = 0;
  for (const m of textOf(mainOf(page)).matchAll(AMOUNT)) {
    n += 1;
    assert.ok(allowed.has(centsOf(m[0])), `${label}: ${m[0]} is a company figure (a budget or a policy amount)`);
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------
// Refusal pages: every POST's answer when it says no

/**
 * Every POST refusal of company C, each sent as the roles that can send that form: a stale rev (409), a gone
 * option (410), a short note, a missing reason or choice, a bad amount or field (422), and the other
 * company's member at C's invite (403). Demo adds the trip forms (decide, cancel, submit, swap, message,
 * results); production answers the trip search 503. `setup` (run first) holds what a refusal needs that the
 * world does not have: an out-of-policy draft. Returns [{ label, status, res, priced }].
 */
async function refusals(w, C) {
  const demo = !w.production;
  const out = [];
  const p = C.people;
  const send = async (label, status, call, priced = false) => out.push({ label: `${C.word} ${label}`, status, res: await call, priced });
  const can = perm => Object.entries(p).filter(([, x]) => roles.can(x.role, perm));
  const rev = async (kind, id) => String((await w.svc.repo.getIn(kind, id, C.id)).rev);

  if (demo) {
    const R = C.requests;
    const t = trips({ svc: w.svc, clock: w.clock, quotes: w.quotes }, C);
    const draft = await t.business(p.employee.actor, '2026-12-01', 3, `${C.word} out-of-policy draft`);
    assert.notEqual(draft.evaluation.status, 'within', 'the draft needs a reason');
    const before = storeSnapshot(w.app);
    const trip = (id, act) => `${C.B}/trips/${id}/${act}`;
    await send('decide with a stale rev', 409, p.manager.http.post(trip(R.pending.id, 'decide'), { action: 'approve', note: '', rev: '0' }), true);
    await send('deny with a short note', 422, p.manager.http.post(trip(R.pending.id, 'decide'), { action: 'deny', note: 'No', rev: await rev(KINDS.request, R.pending.id) }), true);
    await send('override with no note', 422, p.owner.http.post(trip(R.pending.id, 'decide'), { action: 'approve', note: '', rev: await rev(KINDS.request, R.pending.id) }), true);
    if (R.patPending) await send('approve over budget unticked', 422, p.manager.http.post(trip(R.patPending.id, 'decide'), { action: 'approve', note: '', rev: await rev(KINDS.request, R.patPending.id) }), true);
    await send('cancel with a stale rev', 409, p.employee.http.post(trip(R.pending.id, 'cancel'), { rev: '0' }), true);
    await send('submit with a stale rev', 409, p.employee.http.post(trip(R.draft.id, 'submit'), { rev: '99', reason: REASON, category: 'client_meeting' }), true);
    await send('submit with no reason', 422, p.employee.http.post(trip(draft.id, 'submit'), { rev: String(draft.rev), reason: '', category: '' }), true);
    await send('swap to a gone option', 410, p.employee.http.post(trip(draft.id, 'swap'), { altId: 'alt_ZZZZZZZZZZZZZZZZ', rev: String(draft.rev) }), true);
    await send('a one-letter message', 422, p.employee.http.post(trip(R.pending.id, 'message'), { text: 'a' }), true);
    await send('results with no flight chosen', 422, p.employee.http.post(`${C.B}/trips`, { ...Q, purpose: 'x' }));
    await send('results for a bad search', 422, p.employee.http.post(`${C.B}/trips`, { from: 'XXX', to: 'LHR', depart: 'soon', out: 'x', purpose: 'x' }));
    await send('a bad search', 422, p.employee.http.get(`${C.B}/trips/search?from=XXX&to=LHR&depart=soon`));
    assert.equal(storeSnapshot(w.app), before, `${C.word}: the trip refusals wrote nothing`);
  } else {
    await send('results with no supplier', 503, p.employee.http.post(`${C.B}/trips`, { ...Q, out: 'x', purpose: 'x' }));
    await send('a search with no supplier', 503, p.employee.http.get(`${C.B}/trips/search?${new URLSearchParams(Q)}`));
  }

  const before = storeSnapshot(w.app);
  const dep = C.deps[0];
  for (const [role, x] of can('budget.edit')) {
    await send(`${role}: a budget that is not an amount`, 422, x.http.post(`${C.B}/budgets`, { departmentId: dep.id, period: '2026-Q4', amount: 'abc', rev: '' }));
    await send(`${role}: a budget with a stale rev`, 409, x.http.post(`${C.B}/budgets`, { departmentId: dep.id, period: '2026-Q4', amount: '100', rev: '99' }));
  }
  for (const [role, x] of can('policy.edit')) {
    const pol = await w.svc.getPolicy(x.actor, 'standard');
    const form = extra => formBody({ ...pol.form, rev: String(pol.rev), note: 'x', ...extra });
    await send(`${role}: a policy limit that is not an amount`, 422, x.http.raw(`${C.B}/policies/standard`, form({ 'hotel.default': 'abc' }), FORM));
    await send(`${role}: a policy with a stale rev`, 409, x.http.raw(`${C.B}/policies/standard`, form({ rev: '0' }), FORM));
  }
  const org = await w.svc.repo.getIn(KINDS.org, C.id, C.id);
  const settings = extra => ({ rev: String(org.rev), name: org.name, timezone: org.timezone, outOfPolicy: 'approval', approvalHours: '24', budgetPeriod: 'quarter', ...extra });
  await send('owner: settings with a bad approval time', 422, p.owner.http.post(`${C.B}/settings`, settings({ approvalHours: '9999' })));
  await send('owner: settings from a rev not written yet', 409, p.owner.http.post(`${C.B}/settings`, settings({ rev: String(org.rev + 1) })));
  for (const [role, x] of can('members.manage')) {
    await send(`${role}: an invite to a bad email`, 422, x.http.post(`${C.B}/people/invite`, { email: 'not-an-email', role: 'employee', tier: 'standard' }));
    await send(`${role}: a member with a stale rev`, 409, x.http.post(`${C.B}/people/${p.employee.user.id}`, {
      role: 'employee', tier: 'standard', departmentId: dep.id, managerId: p.manager.user.id, approverId: '', rev: '99',
    }));
    const mine = await rev(KINDS.member, `${C.id}.${x.user.id}`);
    await send(`${role}: removing themselves`, 422, x.http.post(`${C.B}/people/${x.user.id}/remove`, { rev: mine }));
  }
  for (const [role, x] of can('departments.manage')) {
    await send(`${role}: a department with no name`, 422, x.http.post(`${C.B}/departments`, { name: '' }));
    await send(`${role}: a department name in use`, 409, x.http.post(`${C.B}/departments`, { name: dep.name }));
  }
  for (const [role, x] of can('reports.export')) {
    await send(`${role}: a CSV for a bad period`, 422, x.http.post(`${C.B}/reports/export`, { period: 'bad' }));
  }
  const other = C === w.A ? w.B : w.A;
  await send(`${other.word} employee at ${C.word}'s invite`, 403, other.people.employee.http.post(`/business/invite/${C.invite.token}/accept`, {}));
  assert.equal(storeSnapshot(w.app), before, `${C.word}: the refusals wrote nothing`);
  return out;
}
const FORM = 'application/x-www-form-urlencoded';
function formBody(obj) {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) b.append(k, String(x));
    else if (v != null) b.append(k, String(v));
  }
  return b.toString();
}

// ---------------------------------------------------------------------------------------------------------

test('demo config: every page as every role is honest, and every amount is a labelled demo price', async t => {
  const w = await world();
  try {
    const A = w.A, R = A.requests;
    const late = await lateTrip(w, A);
    // The notice for a trip approved by policy: approved, not confirmed.
    const auto = await A.people.employee.http.get(`${A.B}/trips/${R.approved.id}?ok=auto_approved`);
    assert.match(textOf(mainOf(auto.text)), /Inside your policy, so it's approved\. Nothing else is needed from you\./);
    assert.doesNotMatch(textOf(auto.text), /\bconfirmed\b/i);

    let html = 0, amounts = 0, pricedPages = 0, shell = 0;
    const said = new Set();
    const perRoute = new Map();
    const reached = new Set();
    const fetched = await crawlEveryone(w, { [A.word]: [late] }, ({ who, url, res }) => {
      if (!isHtml(res)) return;
      html += 1;
      const label = `${who} ${url} (${res.status})`;
      assertHonest(label, res.text);
      if (assertNoAmountOutsideMain(label, res.text)) shell += 1;
      // Trip prices say when they were priced; budgets, policy limits and the activity log are the company's
      // own figures (or sums of demo prices), labelled as demo prices without a time.
      const priced = /\/trips\/btr_[A-Za-z0-9_-]{16}(?:\?|$)/.test(url) && res.status === 200;
      const n = assertDemoAmounts(label, res.text, { priced });
      amounts += n;
      add(perRoute, routeOf(url), n);
      if (res.status === 200) reached.add(routeOf(url));
      if (priced && n) pricedPages += 1;
      for (const m of textOf(mainOf(res.text)).matchAll(/Flight [a-z]+ too close to departure/g)) said.add(m[0]);
    });
    t.diagnostic(`${fetched} pages fetched, ${html} HTML (${shell} in the shell), ${amounts} amounts, ${pricedPages} trip pages with Priced at`);
    assert.ok(html > 900, `${html} pages crawled`);
    assert.ok(shell > 800, `${shell} shell pages checked for amounts outside <main>`);
    assert.ok(amounts > 2000, `${amounts} amounts checked`);
    assert.ok(pricedPages > 100, `${pricedPages} trip pages checked for Priced at`);
    for (const p of [...WORKSPACE, '/business/o/org/trips/btr', '/business/o/org/trips/search']) assert.ok(reached.has(p), `the crawl reached ${p}`);
    // Amounts were checked where they live: trips, budgets, reports, policies, the activity log and the home page.
    for (const p of ['/business/o/org', '/business/o/org/trips', '/business/o/org/trips/btr', '/business/o/org/approvals', '/business/o/org/budgets',
      '/business/o/org/reports', '/business/o/org/activity', '/business/o/org/policies', '/business/o/org/policies/standard', '/business/o/org/trips/search']) {
      assert.ok(perRoute.get(p) > 0, `amounts checked on ${p}`);
    }
    assert.ok([...said].some(x => /^Flight [a-z]+ too close to departure$/.test(x)), 'Top reasons names the advance rule');

    // The money wording the seeded states carry, each amount in a Demo price container: what a switch saved
    // (on the trip and in the reports), the over-budget approval, and a decider's live check of a new price.
    const saved = money(R.swapped.history.find(h => h.action === 'swapped').savedCents);
    const swapped = await A.people.employee.http.get(`${A.B}/trips/${R.swapped.id}`);
    assert.match(textOf(mainOf(swapped.text)), new RegExp(`Saved \\${saved} by switching to cheaper options\\.`));
    assertBoxed('the swapped trip', swapped.text, saved);
    const reports = await A.people.finance.http.get(`${A.B}/reports?period=2026-Q4`);
    assert.match(textOf(mainOf(reports.text)), new RegExp(`Saved by switching to cheaper options \\${saved}`));
    assertBoxed('the reports', reports.text, saved);
    const over = await A.people.manager.http.get(`${A.B}/trips/${R.patPending.id}`);
    const ack = /Approve even though Acme Sales goes (\$[\d,.]+) over its Q4 2026 budget\./.exec(textOf(mainOf(over.text)));
    assert.ok(ack, 'the over-budget approval names the amount over');
    assertBoxed('the over-budget approval', over.text, ack[1]);
    const live = await A.people.manager.http.get(`${A.B}/trips/${R.liveChanged.id}`);
    const moved = /Price checked again at [^:]+:\d\d [AP]M today: now (\$[\d,.]+) \(was (\$[\d,.]+) ?\)/.exec(textOf(mainOf(live.text)));
    assert.ok(moved, 'the live check names the new and the old price');
    assert.equal(centsOf(moved[1]) - centsOf(moved[2]), 2900, 'the hotel moved by $29');
    assertBoxed('the live check', live.text, moved[1]);
    assertBoxed('the live check', live.text, moved[2]);
  } finally {
    await w.close();
  }
});

for (const production of [false, true]) {
  const cfg = production ? 'production' : 'demo';
  test(`${cfg} config: every POST refusal page is honest, labels its amounts, and writes nothing`, async t => {
    const w = await world({ production });
    try {
      const allowed = production ? await companyFigures(w) : null;
      let amounts = 0, pages = 0;
      for (const C of [w.A, w.B]) {
        for (const { label, status, res, priced } of await refusals(w, C)) {
          const l = `${cfg} ${label}`;
          assert.equal(res.status, status, `${l}: ${textOf(mainOf(res.text)).slice(0, 200)}`);
          assert.ok(isHtml(res), `${l}: a page`);
          pages += 1;
          assertHonest(l, res.text);
          assertNoAmountOutsideMain(l, res.text);
          amounts += production ? assertProductionPage(l, res.text, allowed) : assertDemoAmounts(l, res.text, { priced });
          if (priced) assert.ok(amountsOf(mainOf(res.text)).length > 0, `${l}: the trip's prices are on the page`);
        }
      }
      t.diagnostic(`${pages} refusal pages, ${amounts} amounts`);
      assert.ok(pages >= (production ? 40 : 60), `${pages} refusal pages`);
      assert.ok(amounts > (production ? 20 : 200), `${amounts} amounts checked`);
    } finally {
      await w.close();
    }
  });

  test(`${cfg} config: the CSV and the company export are honest, and only demo data says demo`, async () => {
    const w = await world({ production });
    try {
      for (const C of [w.A, w.B]) {
        for (const role of ['finance', 'owner']) {
          const res = await C.people[role].http.post(`${C.B}/reports/export`, { period: '2026-Q4' });
          assert.equal(res.status, 200, `${C.word} ${role} CSV`);
          const lines = res.text.replace(/^﻿/, '').trim().split(/\r?\n/);
          assert.equal(lines[0].split(',')[0], 'price_source', 'the first column is price_source');
          if (production) {
            assert.equal(lines.length, 1, 'no rows without trips');
            assert.doesNotMatch(res.text, /\bdemo\b/i, `${C.word} CSV says nothing about demo data`);
            assert.doesNotMatch(res.text, /test data|sandbox|supplier/i, `${C.word} CSV says nothing about supplier prices or test data`);
          } else {
            assert.ok(lines.length >= 7, `${C.word} CSV has its requests`);
            for (const line of lines.slice(1)) assert.ok(line.startsWith('Demo price,'), `${C.word} CSV row: ${line.slice(0, 80)}`);
          }
          assertHonestText(`${cfg} ${C.word} ${role} CSV`, res.text);
        }
        const ex = await C.people.owner.http.post(`${C.B}/settings/export`, {});
        assert.equal(ex.status, 200, `${C.word} export`);
        const data = JSON.parse(ex.text);
        assert.equal(data.org.id, C.id);
        assert.match(data.note, /nothing was booked or charged/i);
        if (production) {
          assert.doesNotMatch(ex.text, /\bdemo\b/i, `${C.word} export says nothing about demo data`);
          assert.doesNotMatch(ex.text, /test data|sandbox|supplier/i, `${C.word} export says nothing about supplier prices or test data`);
        } else assert.match(data.note, /\bdemo prices\b/, `${C.word} export note names demo prices`);
        assertHonestText(`${cfg} ${C.word} export`, ex.text);
      }
    } finally {
      await w.close();
    }
  });
}

test('demo config: the people page and a new invite say we don\'t send email yet; nothing says an email went out', async () => {
  const w = await world();
  try {
    for (const C of [w.A, w.B]) {
      for (const role of ['owner', 'admin']) {
        const people = await C.people[role].http.get(`${C.B}/people`);
        assert.equal(people.status, 200);
        assert.match(textOf(mainOf(people.text)), /We don't send email yet\./, `${C.word} ${role} people page`);
        const made = await C.people[role].http.post(`${C.B}/people/invite`, { email: `invitee.${role}@${C.domain}`, role: 'employee', tier: 'standard' });
        assert.equal(made.status, 200, `${C.word} ${role} invite: ${textOf(mainOf(made.text)).slice(0, 200)}`);
        assert.match(textOf(mainOf(made.text)), /We don't send email yet\./, `${C.word} ${role} invite link page`);
        assert.match(made.text, /\/business\/invite\/[A-Za-z0-9_-]{20,}/, 'the link to copy');
        assertHonest(`${C.word} ${role} invite link page`, made.text);
      }
      // Sending a trip for approval says who sees it, not that an email went.
      const sent = await C.people.employee.http.get(`${C.B}/trips/${C.requests.pending.id}?ok=submitted`);
      assert.match(textOf(mainOf(sent.text)), /We don't send emails yet, so .+ will see it under Approvals\./);
      assertHonest(`${C.word} submitted notice`, sent.text);
    }
  } finally {
    await w.close();
  }
});

test('production config: no page says demo or shows a demo price, and every amount is a company figure', async t => {
  const w = await world({ production: true });
  try {
    assert.equal(w.svc.inventory.status, 'none', 'no supplier in production');
    const allowed = await companyFigures(w);
    let html = 0, amounts = 0, shell = 0;
    const perRoute = new Map();
    const statuses = new Map();
    const fetched = await crawlEveryone(w, {}, ({ who, url, res }) => {
      if (!isHtml(res)) return;
      html += 1;
      const label = `${who} ${url} (${res.status})`;
      assertHonest(label, res.text);
      if (assertNoAmountOutsideMain(label, res.text)) shell += 1;
      const n = assertProductionPage(label, res.text, allowed);
      amounts += n;
      add(perRoute, routeOf(url), n);
      const route = routeOf(url);
      if (!statuses.has(route)) statuses.set(route, new Set());
      statuses.get(route).add(res.status);
    });
    t.diagnostic(`${fetched} pages fetched, ${html} HTML (${shell} in the shell), ${amounts} amounts`);
    assert.ok(html > 300, `${html} pages crawled`);
    assert.ok(shell > 250, `${shell} shell pages checked for amounts outside <main>`);
    assert.ok(amounts > 50, `${amounts} amounts checked`);
    for (const p of WORKSPACE) assert.ok((statuses.get(p) || new Set()).has(200), `the crawl reached ${p}`);
    // The trip search answers that no supplier is connected (and was checked like every other page).
    assert.ok((statuses.get('/business/o/org/trips/search') || new Set()).has(503), 'the crawl reached the search page (503)');
    for (const p of ['/business/o/org/budgets', '/business/o/org/activity', '/business/o/org/policies', '/business/o/org/policies/standard']) {
      assert.ok(perRoute.get(p) > 0, `company figures checked on ${p}`);
    }
    const search = await w.A.people.employee.http.get(`${w.A.B}/trips/search?${new URLSearchParams(Q)}`);
    assert.equal(search.status, 503);
    assert.match(textOf(mainOf(search.text)), /Supplier not connected yet/);
    // The people page says the same about email in production.
    const people = await w.A.people.owner.http.get(`${w.A.B}/people`);
    assert.match(textOf(mainOf(people.text)), /We don't send email yet\./);
  } finally {
    await w.close();
  }
});
