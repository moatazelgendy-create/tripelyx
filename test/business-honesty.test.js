// Honesty (plan §L Stage 3, A3): every Business page, as every role, says only what is true today. Demo
// inventory is labelled at every amount, nothing claims a trip was booked, ticketed, charged or emailed, no
// page pushes with urgency or scarcity, and no supplier, rating or review reaches the HTML. With no supplier
// (production) the pages show the company's own figures only, and nothing is called a demo price.
//
// The seeded world (test/business-world.js) has two companies with every role, requests in every state, a
// pending invite, budgets and a second policy version. On top of it, Acme has a trip planned three days
// ahead, so the "Top reasons" tiles name the advance rule.
//
// Words a reader sees are checked after the honest negations are written out ("Nothing was booked or
// charged.", "We don't send email yet."), so only a claim is left to fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { world, keyWhere, Q, REASON, textOf, mainOf, crawl } = require('./business-world');
const tokens = require('../server/business/tokens');

// The experience engine's pressure list, read from the one place it lives, so the two never drift apart.
const PRESSURE = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'experience-pages.test.js'), 'utf8');
  const m = /^const PRESSURE = \/(.+)\/([a-z]*);$/m.exec(src);
  assert.ok(m, 'the PRESSURE list of test/experience-pages.test.js');
  return new RegExp(m[1], m[2]);
})();
const EM_DASH = /\u2014|&mdash;|&#8212;|&#x2014;/i;

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
];
/** Claims and words no Business page uses (the plan's list, plus what a booking would leave behind). */
const CLAIMS = [
  ['booked', /\bbooked\b|\bbooking (?:is )?confirmed\b/i],
  ['charged', /\bcharged\b|\bcharge (?:was|has been) made\b/i],
  ['emailed', /\bemailed\b|\bemails? (?:was |were |has been |have been |is |are )?sent\b|\bsent (?:you |them |him |her )?(?:an? )?emails?\b/i],
  ['ticket', /\b(?:e-?)?ticket(?:s|ed|ing)?\b/i],
  ['PNR', /\bPNRs?\b|\bbooking reference\b|\bconfirmation (?:number|code)\b|\brecord locator\b/i],
  ['Sold out', /\bsold out\b/i],
  ['reviews', /\breviews\b|\b\d[\d,.]*\s*(?:reviews?|ratings?)\b|\brated\b|\bratings?\b|\b\d(?:\.\d)?\s*(?:\/\s*5|out of 5)\b/i],
  ['pressure', PRESSURE],
];
/** No supplier, provider, rating or internal field in the markup (attributes, data and scripts included). */
const MARKUP = /BusinessDemo|Mock\w*Provider|\bproviders?\b|\bsupplier(?:QuoteRef|Ref)\b|\bnet(?:Cents|Rate)|\bcommission\b|\bmarkup\b|\bduffel\b|\bamadeus\b|\bsabre\b|\btravelport\b|\bexpedia\b|booking\.com|\bhotelbeds\b|\bskyscanner\b|kiwi\.com|\bagoda\b|\bpriceline\b|\btripadvisor\b|data-(?:rating|reviews?|remaining|provider|stock)\b|["'](?:rating|reviewCount|reviews|provider|remaining|seatsLeft|roomsLeft)["']\s*:/i;

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
  // The page's own copy (the site-wide build banner outside <main> belongs to the main site's layout).
  assert.doesNotMatch(textOf(mainOf(s)), EM_DASH, `${label}: no em dash`);
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

/** The start pages of a crawl in company C: home, filtered lists, every notice, and the shell 404. */
function seedsFor(C, extraRequests = []) {
  const urls = [
    C.B, `${C.B}/trips?scope=all`, `${C.B}/trips?scope=team`, `${C.B}/approvals?tab=decided`, `${C.B}/activity?group=trips`,
    `${C.B}/reports?period=2026-Q4`, `${C.B}/budgets?period=2026-Q4`, `${C.B}/trips/btr_ZZZZZZZZZZZZZZZZ`, '/business/app',
  ];
  for (const [page, code] of ADMIN_OK) urls.push(`${C.B}/${page}?ok=${code}`);
  for (const r of [...Object.values(C.requests), ...extraRequests]) for (const code of REQUEST_OK) urls.push(`${C.B}/trips/${r.id}?ok=${code}`);
  return urls;
}

const isHtml = res => /text\/html/.test(res.headers.get('content-type') || '');
/** A crawled URL as its route: ids written as their prefix, no query. */
const routeOf = url => url.replace(/\?.*$/, '').replace(/(org|btr|usr|inv)_[A-Za-z0-9_-]{16}/g, '$1');
const add = (map, k, n) => map.set(k, (map.get(k) || 0) + n);

/** Crawl as everyone: each role of both companies, Pat Both, the platform admin and a stranger. */
async function crawlEveryone(w, extra = {}) {
  const pages = [];
  const stranger = w.http('');
  for (const C of [w.A, w.B]) {
    for (const [role, p] of Object.entries(C.people)) {
      const seen = await crawl(p.http, seedsFor(C, extra[C.word] || []), { cap: 600 });
      for (const [url, res] of seen) pages.push({ who: `${C.word} ${role}`, url, res, C });
    }
  }
  const publicUrls = ['/business', '/business/start', '/business/signin', '/business/app', `/business/invite/${w.A.invite.token}`, `/business/invite/${tokens.newToken()}`, `${w.A.B}`];
  for (const [who, h] of [['stranger', stranger], ['Pat Both', w.both.http], ['platform admin', w.ops.http]]) {
    const seen = await crawl(h, [...publicUrls, `${w.A.B}`, `${w.B.B}`], { cap: 600 });
    for (const [url, res] of seen) pages.push({ who, url, res, C: null });
  }
  for (const url of ['/admin/business', `/admin/business?ok=active&org=${w.A.id}`, `/admin/business?ok=suspended&org=${w.B.id}`]) {
    pages.push({ who: 'platform admin', url, res: await w.ops.http.get(url), C: null });
  }
  return pages;
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

// ---------------------------------------------------------------------------------------------------------

test('demo config: every page as every role is honest, and every amount is a labelled demo price', async t => {
  const w = await world();
  try {
    const late = await lateTrip(w, w.A);
    const pages = await crawlEveryone(w, { [w.A.word]: [late] });
    let html = 0, amounts = 0, pricedPages = 0;
    const said = new Set();
    const perRoute = new Map();
    for (const { who, url, res } of pages) {
      if (!isHtml(res)) continue;
      html += 1;
      const label = `${who} ${url} (${res.status})`;
      assertHonest(label, res.text);
      // Trip prices say when they were priced; budgets, policy limits and the activity log are the company's
      // own figures (or sums of demo prices), labelled as demo prices without a time.
      const priced = /\/trips\/btr_[A-Za-z0-9_-]{16}(?:\?|$)/.test(url) && res.status === 200;
      const n = assertDemoAmounts(label, res.text, { priced });
      amounts += n;
      add(perRoute, routeOf(url), n);
      if (priced && n) pricedPages += 1;
      for (const m of textOf(mainOf(res.text)).matchAll(/Flight [a-z]+ too close to departure/g)) said.add(m[0]);
    }
    t.diagnostic(`${html} pages, ${amounts} amounts, ${pricedPages} trip pages with Priced at`);
    assert.ok(html > 900, `${html} pages crawled`);
    assert.ok(amounts > 2000, `${amounts} amounts checked`);
    assert.ok(pricedPages > 100, `${pricedPages} trip pages checked for Priced at`);
    // The pages the crawl must have reached: each kind of workspace page, as the roles that see it.
    const reached = new Set(pages.filter(x => x.res.status === 200).map(x => routeOf(x.url)));
    for (const p of ['/business/o/org', '/business/o/org/trips', '/business/o/org/trips/btr', '/business/o/org/trips/new', '/business/o/org/trips/search',
      '/business/o/org/approvals', '/business/o/org/policy', '/business/o/org/policies', '/business/o/org/policies/standard', '/business/o/org/policies/standard/history',
      '/business/o/org/budgets', '/business/o/org/people', '/business/o/org/reports', '/business/o/org/activity', '/business/o/org/settings', '/business',
      '/business/start', '/business/signin', '/business/app', '/admin/business']) {
      assert.ok(reached.has(p), `the crawl reached ${p}`);
    }
    // Amounts were checked where they live: trips, budgets, reports, policies, the activity log and the home page.
    for (const p of ['/business/o/org', '/business/o/org/trips', '/business/o/org/trips/btr', '/business/o/org/approvals', '/business/o/org/budgets',
      '/business/o/org/reports', '/business/o/org/activity', '/business/o/org/policies', '/business/o/org/policies/standard', '/business/o/org/trips/search']) {
      assert.ok(perRoute.get(p) > 0, `amounts checked on ${p}`);
    }
    // The advance rule is named in plain words, and a trip approved by policy is approved, not confirmed.
    assert.ok([...said].some(x => /^Flight [a-z]+ too close to departure$/.test(x)), 'Top reasons names the advance rule');
    const auto = await w.A.people.employee.http.get(`${w.A.B}/trips/${w.A.requests.approved.id}?ok=auto_approved`);
    assert.match(textOf(mainOf(auto.text)), /Inside your policy, so it's approved\. Nothing else is needed from you\./);
    assert.doesNotMatch(textOf(auto.text), /\bconfirmed\b/i);
  } finally {
    await w.close();
  }
});

test('demo config: the CSV labels every row a demo price, and says nothing was booked', async () => {
  const w = await world();
  try {
    for (const C of [w.A, w.B]) {
      for (const role of ['finance', 'owner']) {
        const res = await C.people[role].http.post(`${C.B}/reports/export`, { period: '2026-Q4' });
        assert.equal(res.status, 200, `${C.word} ${role} CSV`);
        const lines = res.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
        assert.equal(lines[0].split(',')[0], 'price_source', 'the first column is price_source');
        assert.ok(lines.length >= 7, `${C.word} CSV has its requests`);
        for (const line of lines.slice(1)) assert.ok(line.startsWith('Demo price,'), `${C.word} CSV row: ${line.slice(0, 80)}`);
        let words = res.text;
        for (const re of HONEST) words = words.replace(re, ' ');
        for (const [name, re] of CLAIMS) assert.doesNotMatch(words, re, `${C.word} CSV: ${name}`);
        assert.doesNotMatch(res.text, MARKUP, `${C.word} CSV: no supplier or internal field`);
      }
    }
  } finally {
    await w.close();
  }
});

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

test('production config: no page shows a demo price or an amount from demo data, and every amount is a company figure', async t => {
  const w = await world({ production: true });
  try {
    assert.equal(w.svc.inventory.status, 'none', 'no supplier in production');
    // The company's own figures: budgets (and what is left of them, all of it), zero, and every policy amount.
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
    const pages = await crawlEveryone(w);
    let html = 0, amounts = 0;
    const perRoute = new Map();
    for (const { who, url, res } of pages) {
      if (!isHtml(res)) continue;
      html += 1;
      const label = `${who} ${url} (${res.status})`;
      assertHonest(label, res.text);
      assert.doesNotMatch(res.text, /data-price-source="demo"|Demo price|Priced at/i, `${label}: no demo price label`);
      for (const m of textOf(mainOf(res.text)).matchAll(AMOUNT)) {
        amounts += 1;
        add(perRoute, routeOf(url), 1);
        assert.ok(allowed.has(centsOf(m[0])), `${label}: ${m[0]} is a company figure (a budget or a policy amount)`);
      }
    }
    t.diagnostic(`${html} pages, ${amounts} amounts`);
    assert.ok(html > 300, `${html} pages crawled`);
    assert.ok(amounts > 50, `${amounts} amounts checked`);
    for (const p of ['/business/o/org/budgets', '/business/o/org/activity', '/business/o/org/policies', '/business/o/org/policies/standard']) {
      assert.ok(perRoute.get(p) > 0, `company figures checked on ${p}`);
    }
    // The CSV has its header (price_source first) and no rows: there are no trips.
    const csv = await w.A.people.finance.http.post(`${w.A.B}/reports/export`, { period: '2026-Q4' });
    assert.equal(csv.status, 200);
    const lines = csv.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.equal(lines[0].split(',')[0], 'price_source');
    assert.equal(lines.length, 1, 'no rows without trips');
    // The people page says the same about email in production.
    const people = await w.A.people.owner.http.get(`${w.A.B}/people`);
    assert.match(textOf(mainOf(people.text)), /We don't send email yet\./);
  } finally {
    await w.close();
  }
});
