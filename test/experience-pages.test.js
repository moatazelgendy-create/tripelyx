// EXPERIENCE MAX's pages, through HTTP: the homepage asks WHAT DO YOU WANT FROM THIS TRIP? with four
// submit buttons and BUILD ME AN EXPERIENCE, and each starts the agent's mission in its mode; the
// memories page renders every section in order, every amount on it is the priced total of the token
// its link opens (with the context carried), the receipt's lines add up to the difference it claims,
// the budget rows add up to the total, nothing is preselected, free things appear only with a source
// and the date they were checked, and the rhythm never puts the main experience on the arrival or the
// departure day; the trip page carries the two buttons and "Protect this experience", the review page
// the experience receipt, protection, final check and the "very scheduled" line; the booking page asks
// WHAT WAS ACTUALLY WORTH IT? only after the trip, keeps the answer on the booking, and remembers it
// on the account only when the box is ticked by the signed-in owner. No page pressures anyone.
// No dollar figure is hard-coded: every trip comes from a search, every number is priced by the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fixedNow } = require('./helpers');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const optimizer = require('../server/trips/optimizer');
const X = require('../server/trips/experience');
const { ENTRY_MODES } = require('../server/views/trips/home');
const { longDate } = require('../server/views/trips/common');
const { GUIDE_CHECKED_AT } = require('../server/trips/demo-data/destinations');

const money = c => format(c, 'USD');
// The stylesheet's rules as { media, selectors, decls } (a rule inside @media carries its condition): the layout tests read
// the rule that causes or prevents a phone layout bug; a Playwright probe at 390px checks the same pages in a browser.
const CSS = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/trips.css'), 'utf8');
function cssRules(css) {
  const out = [];
  const walk = (src, media) => {
    for (let j = 0; j < src.length;) {
      const open = src.indexOf('{', j); if (open < 0) break;
      let depth = 1, k = open + 1; while (k < src.length && depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
      const head = src.slice(j, open).trim(), body = src.slice(open + 1, k - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) out.push({ media, selectors: head.split(',').map(x => x.trim()), decls: Object.fromEntries(body.split(';').map(d => d.split(':')).filter(x => x.length >= 2).map(([n, ...v]) => [n.trim(), v.join(':').trim()])) });
      j = k;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), null);
  return out;
}
const CSS_RULES = cssRules(CSS), PHONE = '@media (max-width: 640px)';
// The last declaration of `prop` for exactly `sel` (outside any media query, or inside `media`).
const decl = (sel, prop, media = null) => { const r = CSS_RULES.filter(x => x.selectors.includes(sel) && x.media === media && prop in x.decls); return r.length ? r[r.length - 1].decls[prop] : undefined; };
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
// The experience engine's own list (test/experience.test.js): urgency, scarcity, predictions, and a
// guarantee unless it is denied ("the weather itself can't be guaranteed").
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const noInline = (p, body) => { assert.ok(!/\sstyle="/.test(body), `${p} inline style`); assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} inline script`); };
const CARD = { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'Ada Lovelace' };
const TRAVELER = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const GOALS = ['beach', 'food', 'nature'];
const SECTIONS = ['goals', 'receipt', 'budget', 'rhythm', 'hotel-or-experience', 'make-memorable', 'big-or-many', 'free', 'location', 'schedule', 'ladder', 'same-feeling', 'alternative', 'protection', 'final-check', 'more'];
function fixedClock() { const d = fixedNow(); d.setUTCHours(9, 0, 0, 0); return d; }
const sum = xs => xs.reduce((n, x) => n + x, 0);
const attrs = (html, name) => [...html.matchAll(new RegExp(`${name}="(-?\\d+)"`, 'g'))].map(m => Number(m[1]));
// One section of a page: from its id to the next section (or the end of the page's main).
const section = (html, id) => { const at = html.indexOf(`id="${id}"`); assert.ok(at >= 0, `section ${id}`); const end = html.indexOf('<section', at + 1); return html.slice(at, end < 0 ? html.indexOf('</main>', at) : end); };
// Every link that shows a price: <a … href="/trip/TOKEN[/review]?QUERY" data-total="N">…</a>.
// A control rendered as already chosen: a checked box or a selected option, inside a tag.
const PRESELECTED = /<[^>]*\s(?:checked|selected)(?:=|\s|\/?>)/;
const priced = html => [...html.matchAll(/<a\b[^>]*?href="\/trip\/([^"?\/#]+)(\/review)?\?([^"#]*)(?:#[^"]*)?" data-total="(\d+)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map(m => ({ token: decodeURIComponent(m[1]), review: !!m[2], params: new URLSearchParams(m[3].replace(/&amp;/g, '&')), total: Number(m[4]), words: text(m[5]) }));

function client(base) {
  const jar = {};
  const req = async (path, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'sec-fetch-site': 'same-origin', ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) { const [kv, ...rest] = sc.split(';'); const [k, v] = kv.split('='); if (!v || rest.some(x => /Max-Age=0/i.test(x))) delete jar[k]; else jar[k] = v; }
    const t = await res.text();
    return { status: res.status, location: res.headers.get('location'), text: t, json: () => JSON.parse(t) };
  };
  return { req, jar };
}

// A trip built for the goals from the search's own pick in a destination: the experiences that serve
// a goal, best first, at most `acts`, on the trip's own dates and hotel; `nights` moves the length.
async function goalTrip(app, { dest = null, nights = 6, acts = 3, goals = GOALS, style = 'beach' } = {}) {
  const svc = app.tripService;
  const { query, missing } = svc.parse({ b: '2500', k: '0', from: 'NYC', who: 'couple', when: 'anytime', nights: String(nights), style, prio: 'price', ...(dest ? { dest } : {}) });
  assert.deepEqual(missing, []);
  const pick = (await svc.search(query, { visitor: 'test', user: null })).picks[0].trip;
  const chosen = pick.activityOptions.filter(a => X.goalScore(a, goals) > 0).sort((a, b) => X.goalScore(b, goals) - X.goalScore(a, goals)).slice(0, acts);
  assert.ok(chosen.length >= Math.min(2, acts), `${pick.dest.id} has goal experiences`);
  const trip = await svc.price({ ...pick.spec, activities: chosen.map(a => a.id).sort() });
  assert.ok(trip, 'the goal trip prices');
  return { trip, token: encodeSpec(trip.spec) };
}
const budgetFor = trip => (Math.ceil(trip.total / 100) + 400) * 100;
async function checkPriced(svc, links, label) {
  for (const l of links) {
    const p = await svc.price(decodeSpec(l.token));
    assert.ok(p, `${label}: ${l.token} prices`);
    assert.equal(p.total, l.total, `${label}: ${l.words} is the token's total`);
    assert.ok(l.words.includes(money(l.total)), `${label}: the words show the amount (${l.words})`);
  }
}

test('the homepage: WHAT DO YOU WANT FROM THIS TRIP? as four submit buttons with name=mode, the primary button unchanged, BUILD ME AN EXPERIENCE with its promise; each mode starts the mission in it', async t => {
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const home = await c.req('/');
  assert.equal(home.status, 200);
  noInline('/', home.text);
  const form = home.text.match(/<form class="ag-hero-form ag-hero-number" method="post" action="\/agent">[\s\S]*?<\/form>/)[0];
  assert.match(form, /<legend class="ag-hero-entry-q">WHAT DO YOU WANT FROM THIS TRIP\?<\/legend>/);
  assert.deepEqual(ENTRY_MODES.map(m => [m[0], m[1]]), [['save', 'SAVE THE MOST'], ['value', 'BEST VALUE'], ['easy', 'MAKE IT EASY'], ['experience', 'MAKE IT MEMORABLE']]);
  for (const [value, label] of ENTRY_MODES) assert.match(form, new RegExp(`<button class="btn btn-white ag-hero-mode" type="submit" name="mode" value="${value}">[\\s\\S]*?${label}</button>`), label);
  assert.match(form, /<button class="btn btn-blue btn-lg" type="submit">Show me what my money can do/, 'the primary button stays, with no mode');
  assert.match(form, /<button class="btn btn-blue" type="submit" name="mode" value="experience">[\s\S]*?BUILD ME AN EXPERIENCE<\/button> <span class="ag-hero-promise">SPEND ON THE MEMORIES\. NOT THE LABELS\.<\/span>/);
  assert.ok(form.indexOf('Show me what my money can do') < form.indexOf('WHAT DO YOU WANT FROM THIS TRIP?') && form.indexOf('WHAT DO YOU WANT FROM THIS TRIP?') < form.indexOf('BUILD ME AN EXPERIENCE'));
  // The page's own promises deny pressure in words the blunt regex would catch ("no made-up 'only 2
  // left'"); the sweep covers what this slice adds.
  assert.doesNotMatch(text(form), PRESSURE);
  // Each way in starts the mission in its mode; BEST VALUE, the primary button and an unknown mode are
  // the mission as it is, and a mode without the number starts no mission.
  for (const [mode, want] of [['save', 'save'], ['easy', 'easy'], ['experience', 'experience'], ['value', null], ['', null], ['luxury', null]]) {
    const r = await c.req('/agent', { method: 'POST', form: { budget: '2,000', ...(mode ? { mode } : {}) } });
    assert.equal(r.status, 303, r.text);
    const s = await app.agent.load(r.location.split('/').pop());
    assert.ok(s.mission, mode);
    assert.equal(s.mission.mode, want, mode);
  }
  const bare = await c.req('/agent', { method: 'POST', form: { mode: 'experience', text: 'Somewhere warm' } });
  assert.equal(bare.status, 303);
  assert.equal((await app.agent.load(bare.location.split('/').pop())).mission, null, 'no number, no mission');
  await app.agent.jobs.drain();
});

test('the memories page: every section in order, every amount the priced total of its link\'s token with the context carried, the receipt and the budget add up, nothing preselected, the rhythm keeps the main experience off the travel days', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun' });
  const budget = budgetFor(trip);
  const cxq = `b=${budget / 100}&mem=${GOALS.join(',')}&ns=1`;
  const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq)));
  assert.deepEqual(cx.goals, GOALS);
  const page = await c.req(`/trip/${token}/memories?${cxq}`);
  assert.equal(page.status, 200, page.text.slice(0, 500));
  noInline('/memories', page.text);
  const body = page.text, plain = text(body);
  assert.match(body, /<title>Make it more memorable/);
  assert.doesNotMatch(plain, PRESSURE);
  assert.doesNotMatch(plain, /undefined|NaN|\bnull\b|\[object/);
  // Every section, in the contract's order, with its heading.
  const at = SECTIONS.map(id => body.indexOf(`id="${id}"`));
  assert.ok(at.every(i => i > 0), SECTIONS.filter((id, i) => at[i] < 0).join(', '));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the sections are in order');
  for (const words of [X.SIGNATURE_LINE, 'WHAT DO YOU WANT TO REMEMBER?', 'WHY THIS TRIP IS BUILT THIS WAY', 'YOUR GOAL', 'WE SPENT LESS ON', 'WE USED MONEY FOR', 'FINAL', 'YOUR MAX', 'KEEP', 'YOUR EXPERIENCE BUDGET', 'THE RHYTHM', 'HOTEL OR EXPERIENCE?', 'MAKE $100 MEMORABLE', 'ONE BIG MEMORY vs MORE THINGS TO DO', 'FIND FREE THINGS WORTH DOING', 'LOCATION', 'SCHEDULE CONFLICT', 'GIVE ME MORE FREE TIME', 'EXPERIENCE LADDER', 'SAME FEELING FOR LESS', 'FIND AN ALTERNATIVE EXPERIENCE', 'PROTECTION', 'FINAL EXPERIENCE CHECK', 'MAKE IT BETTER FOR $0 MORE', 'MAKE IT MORE MEMORABLE', X.FINAL_LINE]) assert.ok(plain.includes(words), words);

  // Every amount shown on a link is the total of the token it opens, and the context travels with it.
  const links = priced(body);
  assert.ok(links.length >= 8, `priced links: ${links.length}`);
  await checkPriced(svc, links, 'memories');
  for (const l of links) {
    assert.equal(l.params.get('b'), String(budget / 100), `${l.words}: the budget travels`);
    assert.equal(l.params.get('mem'), GOALS.join(','), `${l.words}: the goals travel`);
    assert.equal(l.params.get('ns'), '1', `${l.words}: the rules travel`);
  }
  // Nothing is preselected and nothing is applied: no checked or selected control, no form that books.
  assert.doesNotMatch(body, PRESELECTED);
  assert.doesNotMatch(section(body, 'goals') + body.slice(body.indexOf('id="receipt"')), /<form\b[^>]*method="post"/i);

  // The data the page was rendered from, for the sums.
  const d = await svc.memories(trip, cx, { amount: 10000 });
  // WHY THIS TRIP IS BUILT THIS WAY: the lines add up to FINAL − the baseline's total.
  const receipt = section(body, 'receipt');
  assert.equal(d.receipt.final, trip.total);
  assert.equal(sum(attrs(receipt, 'data-diff')), d.receipt.final - d.receipt.baseline.total);
  assert.ok(text(receipt).includes(`FINAL ${money(trip.total)} YOUR MAX ${money(budget)} KEEP ${money(budget - trip.total)}`), text(receipt));
  // YOUR EXPERIENCE BUDGET: the rows add up to the total.
  const alloc = section(body, 'budget');
  assert.equal(sum(attrs(alloc, 'data-cents')), trip.total);
  assert.equal(Number(alloc.match(/data-total="(\d+)"/)[1]), trip.total);
  // THE RHYTHM: arrival and departure days hold no experience; the main experience is on a full day.
  const days = [...section(body, 'rhythm').matchAll(/<li class="[^"]*" data-day="(\d+)" data-label="([^"]*)"(?: data-main="([^"]+)")?>([\s\S]*?)<\/li>/g)].map(m => ({ n: Number(m[1]), label: m[2], main: m[3] || null, items: m[4].includes('<small>') }));
  assert.equal(days.length, trip.spec.nights + 1);
  const { main } = svc.experienceMain(trip, cx, GOALS);
  assert.ok(main, 'the trip has a main experience');
  const mainDays = days.filter(x => x.main);
  assert.equal(mainDays.length, 1); assert.equal(mainDays[0].main, main.id);
  assert.ok(mainDays[0].n !== 1 && mainDays[0].n !== days.length, 'the main experience is never on the arrival or departure day');
  assert.ok(!days[0].items && !days[days.length - 1].items, 'nothing on the travel days');
  assert.ok(plain.includes(`MAIN EXPERIENCE: ${main.name}. Protect this experience`));
  // FIND FREE THINGS WORTH DOING: Cancun has guide data, so it is listed with its source and date.
  const free = section(body, 'free');
  assert.ok(d.free && d.free.items.length);
  assert.ok(free.includes(`data-source="${d.free.source}"`));
  // The date it was checked is the guide's own (never today's), written as the page writes dates.
  assert.equal(d.free.checkedAt, GUIDE_CHECKED_AT);
  assert.ok(text(free).includes(`Free according to ${d.free.source}, checked ${longDate(d.free.checkedAt)}.`));
  for (const it of d.free.items) assert.ok(text(free).includes(it.name), it.name);
  // Every "+$0" free row says where it came from.
  for (const li of body.match(/<li data-kind="(?:free|free-thing)"[^>]*>[\s\S]*?<\/li>/g) || []) assert.ok(text(li).includes(`${d.free.source}, checked ${longDate(d.free.checkedAt)}`), text(li));

  // The goal chips are links that change mem=: a chosen one takes itself out, another goes in last.
  const one = await c.req(`/trip/${token}/memories?b=${budget / 100}&mem=beach`);
  const chips = [...one.text.matchAll(/<a class="tb-mem-chip( is-on)?" href="([^"]+)" aria-pressed="(true|false)" data-goal="([a-z]+)">/g)].map(m => ({ on: !!m[1], mem: new URLSearchParams(m[2].replace(/&amp;/g, '&').split('?')[1].split('#')[0]).get('mem'), pressed: m[3], goal: m[4] }));
  assert.equal(chips.length, X.GOALS.length);
  assert.deepEqual(chips.filter(x => x.on).map(x => [x.goal, x.mem, x.pressed]), [['beach', null, 'true']]);
  for (const x of chips.filter(y => !y.on)) assert.equal(x.mem, `beach,${x.goal}`);
  // Three chosen: the rest are shown but not links.
  assert.equal((body.match(/<span class="tb-mem-chip is-off" aria-disabled="true">/g) || []).length, X.GOALS.length - 3);
  // Opened without goals: only the chips, none chosen, nothing judged or suggested.
  const none = await c.req(`/trip/${token}/memories?b=${budget / 100}`);
  assert.equal(none.status, 200);
  assert.ok(none.text.includes('WHAT DO YOU WANT TO REMEMBER?'));
  assert.ok(!none.text.includes('aria-pressed="true"'));
  for (const id of SECTIONS.slice(1)) assert.ok(!none.text.includes(`id="${id}"`), id);
  assert.equal(priced(none.text).length, 0);
  // Another amount: MAKE $250 MEMORABLE, its candidates priced like the rest.
  const amt = await c.req(`/trip/${token}/memories?${cxq}&amt=250`);
  assert.ok(text(amt.text).includes('MAKE $250 MEMORABLE'));
  await checkPriced(svc, priced(section(amt.text, 'make-memorable')), 'amt=250');
});

test('a protected experience: every version offered keeps it, a different trip drops px and says so; no swap is offered for it; the trip page carries the buttons and "Protect this experience"', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun' });
  const budget = budgetFor(trip);
  const cxq = `b=${budget / 100}&mem=${GOALS.join(',')}`;
  const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq)));
  const { main } = svc.experienceMain(trip, cx, GOALS);

  // The trip page: "Make it more memorable", "Why this trip is built this way", and a Protect link for
  // each experience in the trip (none for one not in it).
  const tp = await c.req(`/trip/${token}?${cxq}`);
  assert.equal(tp.status, 200);
  noInline('/trip', tp.text);
  const q = optimizer.contextParams(cx).replace(/&/g, '&amp;');
  const anchor = (href, words) => [...tp.text.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].some(m => m[1] === href && text(m[2]).trim() === words);
  assert.ok(anchor(`/trip/${token}/memories?${q}`, 'Make it more memorable'), 'Make it more memorable');
  assert.ok(anchor(`/trip/${token}/memories?${q}#receipt`, 'Why this trip is built this way'), 'Why this trip is built this way');
  const protects = [...tp.text.matchAll(/<a href="([^"]+)" data-protect="([^"]+)">(?:<svg[^>]*>[\s\S]*?<\/svg>)?\s*Protect this experience<\/a>/g)].map(m => ({ href: m[1].replace(/&amp;/g, '&'), id: m[2] }));
  assert.deepEqual(protects.map(p => p.id).sort(), trip.spec.activities.filter(id => protects.some(p => p.id === id)).sort());
  assert.deepEqual([...new Set(protects.map(p => p.id))].sort(), [...trip.spec.activities].sort(), 'one per experience in the trip');
  for (const p of protects) assert.equal(new URLSearchParams(p.href.split('?')[1].split('#')[0]).get('px'), p.id);
  assert.doesNotMatch(text(tp.text.match(/<p class="tb-mem-protect-link">[\s\S]*?<\/p>/g).join(' ')), PRESSURE);

  // Protected: MAIN EXPERIENCE 🔒 PROTECTED on the trip page; its remove link leaves the protection
  // behind and says so; no change offered keeps px while dropping the experience.
  const px = main.id;
  const pq = `${cxq}&px=${px}`;
  const tpp = await c.req(`/trip/${token}?${pq}`);
  const tplain = text(tpp.text);
  assert.ok(tplain.includes(`MAIN EXPERIENCE 🔒 PROTECTED: ${main.name}.`));
  assert.ok(tplain.includes('MAIN EXPERIENCE 🔒 PROTECTED · Unprotect'));
  assert.ok(tplain.includes('remove (unprotects it)'));
  for (const m of tpp.text.matchAll(/<a\b[^>]*href="\/trip\/([^"?\/#]+)\?([^"#]*)"/g)) {
    const params = new URLSearchParams(m[2].replace(/&amp;/g, '&'));
    if (params.get('px') === px) assert.ok(decodeSpec(decodeURIComponent(m[1])).activities.includes(px), `a link keeps px=${px} only with the experience in it: ${m[1]}`);
  }

  // The memories page under protection: every version that carries px holds the experience; the ones
  // that cannot (a different trip) drop px; FIND AN ALTERNATIVE EXPERIENCE offers no swap for it.
  const mp = await c.req(`/trip/${token}/memories?${pq}`);
  assert.equal(mp.status, 200);
  const links = priced(mp.text);
  await checkPriced(svc, links, 'protected');
  for (const l of links) {
    const has = decodeSpec(l.token).activities.includes(px);
    if (l.params.get('px') === px) assert.ok(has, `${l.words} carries px and keeps the experience`);
    else assert.ok(!has || l.params.get('px') === null, l.words);
  }
  const alt = text(section(mp.text, 'alternative'));
  assert.ok(alt.includes(`${main.name}`) && alt.includes('The protected experience: no swap is offered for it.'));
  assert.ok(text(mp.text).includes(`MAIN EXPERIENCE 🔒 PROTECTED: ${main.name}.`));
  const sf = section(mp.text, 'same-feeling');
  for (const l of priced(sf)) { assert.equal(l.params.get('px'), null, 'a different trip drops the protection'); assert.ok(text(sf).includes('opening it leaves that protection behind')); }
  // A protected experience a version does not hold is said, never dropped quietly.
  const without = trip.spec.activities.filter(id => id !== px);
  const other = await svc.price({ ...trip.spec, activities: without });
  const wp = text((await c.req(`/trip/${encodeSpec(other.spec)}?${pq}`)).text);
  assert.ok(wp.includes(`MAIN EXPERIENCE 🔒 PROTECTED: ${main.name} is not in this version of the trip.`), wp.slice(0, 600));
  assert.ok(wp.includes('Add it back'));
});

test('the review page: EXPERIENCE RECEIPT, EXPERIENCE PROTECTION and FINAL EXPERIENCE CHECK with goals on the link, nothing without; the "very scheduled" line with a priced way to open up a day', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun' });
  const budget = budgetFor(trip);
  const cxq = `b=${budget / 100}&mem=${GOALS.join(',')}`;
  const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq)));
  const { main } = svc.experienceMain(trip, cx, GOALS);
  const review = await c.req(`/trip/${token}/review?${cxq}&px=${main.id}&seen=0`);
  assert.equal(review.status, 200);
  noInline('/review', review.text);
  const panels = review.text.slice(review.text.indexOf('<div class="tb-mem-review">'));
  const pp = text(panels.slice(0, panels.indexOf('<form')));
  assert.doesNotMatch(pp, PRESSURE);
  for (const words of ['EXPERIENCE RECEIPT', 'WHY THIS TRIP IS BUILT THIS WAY', 'EXPERIENCE PROTECTION', `MAIN EXPERIENCE 🔒 PROTECTED: ${main.name}.`, 'Needs verification', 'FINAL EXPERIENCE CHECK']) assert.ok(pp.includes(words), words);
  assert.ok(text(review.text).includes(`${main.name} (MAIN EXPERIENCE 🔒 PROTECTED)`), 'the experiences row marks it');
  const e = await svc.experienceReview(trip, { ...cx, protect: main.id });
  assert.equal(sum(attrs(section(review.text, 'experience-receipt'), 'data-diff')), e.receipt.final - e.receipt.baseline.total);
  if (e.finalCheck.ok) assert.ok(pp.includes(e.finalCheck.text));
  await checkPriced(svc, priced(panels.slice(0, panels.indexOf('<form'))), 'review panels');
  // Without goals or a protected experience on the link, none of it.
  const plainReview = await c.req(`/trip/${token}/review?b=${budget / 100}&seen=0`);
  assert.ok(!plainReview.text.includes('tb-mem-review') && !plainReview.text.includes('EXPERIENCE RECEIPT'));

  // Three experiences in three nights: very scheduled. The review says so, with a version that opens up
  // a day (priced, without the lowest-scoring one, never the main experience), and the final check fails
  // with the rebuild as a link that is priced again on arrival.
  const busy = await goalTrip(app, { dest: 'cancun', nights: 3, acts: 3 });
  assert.equal(busy.trip.activities.length, 3);
  const br = await c.req(`/trip/${busy.token}/review?${cxq}&seen=0`);
  assert.equal(br.status, 200);
  const line = br.text.match(/<p class="tb-tip tb-tip-warn tb-mem-scheduled">[\s\S]*?<\/p>/);
  assert.ok(line, 'the very scheduled line');
  assert.ok(text(line[0]).includes('This itinerary is very scheduled. I can open up a day without changing the main experiences.'));
  const open = priced(line[0]);
  assert.equal(open.length, 1);
  assert.ok(open[0].review, 'it opens the review of that version');
  await checkPriced(svc, open, 'open up a day');
  const busyMain = svc.experienceMain(busy.trip, cx, GOALS).main;
  const kept = decodeSpec(open[0].token).activities;
  assert.equal(kept.length, 2); assert.ok(kept.includes(busyMain.id), 'the main experience stays');
  const fc = text(section(br.text, 'final-check'));
  const be = await svc.experienceReview(busy.trip, cx);
  assert.equal(be.finalCheck.ok, false);
  if (be.finalCheck.rebuild && be.finalCheck.rebuild.token) await checkPriced(svc, priced(section(br.text, 'final-check')), 'rebuild');
  assert.doesNotMatch(fc, PRESSURE);
  // The rebuild is one a customer with these goals would take: it keeps the main experience, never passes by dropping
  // every experience, and what it gives up is said beside its link, by name.
  const rbl = priced(section(br.text, 'final-check')).filter(l => /See the rebuild that passes/.test(l.words));
  assert.equal(rbl.length, 1, 'the rebuild is offered as a link');
  const rs = decodeSpec(rbl[0].token).activities;
  assert.ok(rs.length > 0 && rs.includes(busyMain.id), `the rebuild keeps the main experience (${rbl[0].token})`);
  for (const a of busy.trip.activities.filter(x => !rs.includes(x.id))) assert.match(fc, new RegExp(`gives up [^;]*${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${a.name}: what it gives up is said`);
  assert.ok(!/A rebuild that passes[^.]*0 experiences/.test(fc));
});

// Two sweet spots for one goal (the screenshot: the agent said "I'd stop at $1,530.79" for its 6-night pick, and the canvas link's
// memories page read 6 and 7 nights and said "I'd stop at $1,652.84"). The page reads the ladder for the trip, as the engine
// does for the agent's own query when it names the trip: the same "I'd stop at", and never a night above the trip.
test('the memories page\'s ladder is read for the trip: the "I\'d stop at" the engine gives the agent\'s query for that trip, never a night above it', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService, gs = ['beach', 'food'];
  // The agent's results: $2,000, an assumed 5 nights, anywhere, any date; the pick goes on the canvas, its main experience protected.
  const Q = { budget: 200000, vacationBudget: 200000, keep: 0, budgetInput: 2000, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'surprise', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
  const o = { now: clock, settings: await svc.settings(), locks: {}, cap: Q.budget, nightsOpen: true };
  const w = X.experienceWays(svc.inv, Q, gs, o), P = w.pick.trip, px = X.mainOf(P, gs).id;
  const agentSays = X.sweetSpot(X.ladder(svc.inv, Q, gs, { ...o, protect: px, trip: P }), P);
  const page = await c.req(`/trip/${w.pick.token}/memories?b=${Q.budget / 100}&mem=${gs.join('%2C')}&px=${px}`);
  assert.equal(page.status, 200);
  const lad = text(section(page.text, 'ladder'));
  assert.ok(agentSays.total && lad.includes(agentSays.text), `the page: ${lad}\nthe agent's query: ${agentSays.text}`);
  const rungs = priced(section(page.text, 'ladder'));
  assert.ok(rungs.length > 0); await checkPriced(svc, rungs, 'ladder');
  for (const l of rungs) assert.ok(decodeSpec(l.token).nights <= P.spec.nights, `${l.token}: never a night above the trip`);
  assert.ok(lad.includes(`${P.dest.name} on your dates, ${P.spec.nights - 1} or ${P.spec.nights} nights,`), 'the lengths it read are said');
});

// The phone layout bugs from the screenshots, by the rule that caused each: the protected experience's pill ("included ·
// remove (unprotects it)", nowrap) widened its row to 409px and the page to 449px; the money leak tables' phone rule hid the
// second header of every table with that class, so PROTECTION's "What we know" vanished, STATUS sat over the wrong column and
// "Needs verification" was clipped, and the budget table lost "Amount"; OUR PICK's KEEP box spilled past the card (1fr 1fr
// cannot shrink below an amount); the mission kicker and title ran together ("EXPERIENCE MAXThe most experience"); icons sat
// on a line of their own (svg is display: block site-wide). The 390px Playwright probe checks the same pages in a browser.
test('phone layout: the protected row wraps, the protection and budget tables keep every column readable, the results card\'s boxes stay inside it, the mission title has its own line, icons sit on their line', async t => {
  // 1. The experience rows wrap instead of widening the page.
  assert.equal(decl('.tb-delta', 'white-space'), 'nowrap', 'a pill keeps its words together elsewhere');
  assert.equal(decl('.tb-options-check .tb-opt > .tb-delta', 'white-space'), 'normal', 'an experience row\'s pill may wrap');
  assert.equal(decl('.tb-options-check .tb-opt', 'flex-wrap'), 'wrap', 'the pill goes under the name when both do not fit');
  assert.equal(decl('.tb-options', 'grid-template-columns'), 'minmax(0, 1fr)', 'a row never widens the list');
  // 4. The leak tables' phone rule is the breakdown's own; the experience tables are not leak tables and lose no column.
  const hidden = CSS_RULES.filter(r => r.media === PHONE && r.decls.display === 'none').flatMap(r => r.selectors);
  assert.ok(!hidden.some(x => /^\.tb-leak-table\b/.test(x)), `no phone rule hides a column of every leak table: ${hidden.join(' | ')}`);
  assert.ok(hidden.includes('.tb-leak-breakdown th:nth-child(2)') && hidden.includes('.tb-leak-breakdown td:nth-child(2)'), 'the breakdown hides its Kind header and cells together');
  assert.ok(!hidden.some(x => /tb-mem/.test(x)), 'no experience table hides a column on a phone');
  assert.equal(decl('.tb-mem-protect tr', 'display', PHONE), 'grid', 'PROTECTION stacks on a phone: the check and its status, what we know under it');
  assert.equal(decl('.tb-mem-protect td:nth-child(2)', 'grid-column', PHONE), '1 / -1');
  assert.ok(!CSS_RULES.some(r => r.media === PHONE && r.selectors.some(x => /tb-mem-protect (th|td)\b/.test(x)) && r.decls['white-space'] === 'nowrap'), 'no status forced onto one line it cannot fit');
  assert.equal(decl('.tb-mem-table .tb-mem-num', 'text-align'), 'right', 'the budget amounts sit under their header');
  // a, b, c.
  assert.equal(decl('.ag-way-nums', 'flex-wrap'), 'wrap'); assert.equal(decl('.ag-way-nums', 'grid-template-columns'), undefined, 'TOTAL and KEEP stack when the card is narrow');
  assert.equal(decl('.ag-mission-title', 'display'), 'block'); assert.equal(decl('.ag-mission-head .tb-kicker', 'display'), 'block');
  assert.equal(decl('.tb-mem-iconline', 'display'), 'flex'); assert.equal(decl('.tb-mem-protect-link a', 'display'), 'inline-flex');

  // The markup those rules read, from the pages themselves.
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun', acts: 1 });
  const main = svc.experienceMain(trip, { goals: GOALS }, GOALS).main, cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`;
  const tp = (await c.req(`/trip/${token}?${cxq}`)).text;
  assert.match(tp, new RegExp(`<p class="tb-mem-protect-link"><a href="[^"]*" data-protect="${main.id}"><svg class="icon"[\\s\\S]*?</svg> Protect this experience</a>`), 'the lock inside the link, on its line');
  const pp = (await c.req(`/trip/${token}?${cxq}&px=${main.id}`)).text;
  const opts = pp.slice(pp.indexOf('<ul class="tb-options tb-options-check">'));
  assert.match(opts.slice(0, opts.indexOf('</ul>')), /<li class="is-on is-protected">[\s\S]*?<span class="tb-delta tb-delta-same">included · remove \(unprotects it\)<\/span>/);
  const mp = (await c.req(`/trip/${token}/memories?${cxq}`)).text;
  const prot = section(mp, 'protection'), budget = section(mp, 'budget');
  assert.match(prot, /<table class="tb-mem-table tb-mem-protect" role="table">\s*<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Check<\/th><th scope="col" role="columnheader">What we know<\/th><th scope="col" role="columnheader">Status<\/th><\/tr><\/thead>/);
  assert.match(budget, /<table class="tb-mem-table tb-mem-alloc">\s*<thead><tr><th scope="col">Part of the trip<\/th><th scope="col" class="tb-mem-num">Amount<\/th><\/tr><\/thead>/);
  assert.ok(!/tb-leak-table/.test(prot) && !/tb-leak-table/.test(budget), 'the experience tables are not leak tables');
  for (const row of prot.match(/<tr role="row" class="is-[a-z]+"[^>]*>[\s\S]*?<\/tr>/g)) assert.equal((row.match(/<td role="cell">/g) || []).length, 3, 'three cells a row, one per header');
  if (main.weather) assert.match(prot, /<p class="tb-small tb-mem-iconline"><svg class="icon"[^>]*>[\s\S]*?<\/svg><span>Weather-dependent: /, 'the sun on the weather line');
  const r = await c.req('/agent', { method: 'POST', form: { budget: '2,000', mode: 'experience' } });
  const ag = (await c.req(r.location)).text;
  assert.match(ag, /<div class="ag-mission-head"><div><p class="tb-kicker">Your mission · Experience Max<\/p><b class="ag-mission-title">The most experience from \$2,000<\/b><\/div>/);
  await app.agent.jobs.drain();
});

test('the memories page without free data says so, and calls nothing free', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const dest = svc.inv.maps.listDestinations().find(d => !X.freeThings(svc.inv, d.id, GOALS) && d.styles.includes('beach'));
  assert.ok(dest, 'a beach destination without guide data');
  const { trip, token } = await goalTrip(app, { dest: dest.id, acts: 2 });
  assert.equal(trip.dest.id, dest.id);
  const page = await c.req(`/trip/${token}/memories?b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`);
  assert.equal(page.status, 200);
  const free = text(section(page.text, 'free'));
  assert.ok(free.includes(`No verified free options for ${dest.name} in our data.`), free);
  assert.ok(!page.text.includes('data-source='));
  assert.doesNotMatch(page.text, /data-kind="free(?:-thing)?"/);
  assert.doesNotMatch(text(page.text), /free according to/i);
  await checkPriced(svc, priced(page.text), dest.id);
  assert.doesNotMatch(text(page.text), PRESSURE);
});

test('WHAT WAS ACTUALLY WORTH IT? after the trip only, nothing preselected; kept on the booking; on the account only with the box ticked by the signed-in owner', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun' });
  const budget = budgetFor(trip);
  const book = async c => {
    const review = await c.req(`/trip/${token}/review?b=${budget / 100}&mem=${GOALS.join(',')}&seen=0`);
    const approvedTotal = Number(review.text.match(/name="approvedTotal" value="(\d+)"/)[1]);
    const cxField = review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
    const q = await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField, promo: '' } });
    assert.equal(q.status, 303, q.text);
    const created = await c.req('/api/bookings', { method: 'POST', json: { quoteId: q.location.split('/').pop(), traveler: TRAVELER } });
    assert.equal(created.status, 201, created.text);
    const b = created.json().booking;
    assert.equal((await c.req(`/api/bookings/${b.ref}/pay`, { method: 'POST', json: { method: CARD } })).status, 200);
    return b;
  };
  // The owner, signed in, and a guest who booked signed out.
  const owner = client(app.base);
  assert.equal((await owner.req('/signup', { method: 'POST', form: { name: 'Ada Lovelace', email: 'worth@example.com', password: 'correct horse battery', next: '/my-trips' } })).status, 303);
  const mine = await book(owner);
  const guest = client(app.base);
  const theirs = await book(guest);
  const stored = await app.store.getBookingByRef(mine.ref);
  assert.ok(stored.userId, 'the signed-in booking belongs to the account');
  const userId = stored.userId;

  // Before the trip: no question on the page, and a post is turned away as early.
  const before = await owner.req(`/booking/${mine.ref}`);
  assert.equal(before.status, 200);
  assert.ok(!before.text.includes('WHAT WAS ACTUALLY WORTH IT?'));
  const early = await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Food']] });
  assert.equal(early.status, 303); assert.equal(early.location, `/booking/${mine.ref}?worthError=early#worth-it`);
  assert.equal((await app.store.getBookingByRef(mine.ref)).worthIt, undefined);

  // The day after the return flight: the question, with nothing preselected.
  clock.setTime(Date.parse(`${addDays(trip.flight.return, 1)}T09:00:00Z`));
  const after = await owner.req(`/booking/${mine.ref}`);
  noInline('/booking', after.text);
  const panel = after.text.match(/<section class="tb-panel tb-mem-worth" id="worth-it"[\s\S]*?<\/section>/)[0];
  const pt = text(panel);
  assert.ok(pt.includes('WHAT WAS ACTUALLY WORTH IT?'));
  for (const chip of X.WORTH_IT_CHIPS) { assert.ok(panel.includes(`name="worth" value="${chip}"`), chip); assert.ok(panel.includes(`name="not" value="${chip}"`), chip); }
  assert.deepEqual(X.WORTH_IT_CHIPS, ['Hotel', 'Food', 'Main experience', 'Free time', 'Nightlife', 'Location', 'Other']);
  assert.ok(panel.includes('<input type="checkbox" name="remember" value="1"> Remember this for next time'));
  assert.doesNotMatch(panel, PRESELECTED, 'nothing preselected');
  assert.ok(panel.includes(`action="/booking/${mine.ref}/worth-it"`));
  assert.doesNotMatch(pt, PRESSURE);

  // The same chip as both, or nothing at all: nothing is kept, and the page says why.
  const both = await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Hotel'], ['not', 'Hotel']] });
  assert.equal(both.location, `/booking/${mine.ref}?worthError=both#worth-it`);
  assert.ok(text((await owner.req(both.location.replace('#worth-it', ''))).text).includes('You marked the same thing as both worth it and not worth it, so nothing was kept.'));
  const empty = await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['other', '']] });
  assert.equal(empty.location, `/booking/${mine.ref}?worthError=empty#worth-it`);
  assert.equal((await app.store.getBookingByRef(mine.ref)).worthIt, undefined);

  // Box not ticked: kept on the booking only, the account untouched.
  const sent = await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Main experience'], ['worth', 'Free time'], ['not', 'Hotel'], ['other', 'The boat day was the trip']] });
  assert.equal(sent.status, 303); assert.equal(sent.location, `/booking/${mine.ref}?worth=1#worth-it`);
  let b = await app.store.getBookingByRef(mine.ref);
  assert.deepEqual(b.worthIt.worth, ['Main experience', 'Free time']); assert.deepEqual(b.worthIt.notWorth, ['Hotel']);
  assert.equal(b.worthIt.other, 'The boat day was the trip'); assert.equal(b.worthIt.defaults, 'not-asked');
  const d0 = await app.store.getRecord('travel_defaults', userId);
  assert.ok(!d0 || !d0.experiencePrefs, 'nothing on the account without the box');
  const thanksPage = (await owner.req(`/booking/${mine.ref}?worth=1`)).text, thanks = text(thanksPage);
  // The icon before "Kept on this booking" sits on that line (svg is display: block site-wide; the line is a flex row).
  assert.match(thanksPage, /<p class="tb-small tb-mem-iconline"><svg class="icon"[^>]*>[\s\S]*?<\/svg><span>Kept on this booking only: you did not ask me to remember it\./);
  assert.ok(thanks.includes('Thanks. Here is what was kept, and where.'));
  assert.ok(thanks.includes('Worth it: Main experience and Free time') && thanks.includes('Not worth it: Hotel'));
  assert.ok(thanks.includes('Kept on this booking only: you did not ask me to remember it.'));

  // Box ticked by the signed-in owner: kept on the booking and in the account's travel defaults.
  const remember = await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Main experience'], ['not', 'Hotel'], ['remember', '1']] });
  assert.equal(remember.location, `/booking/${mine.ref}?worth=1#worth-it`);
  b = await app.store.getBookingByRef(mine.ref);
  assert.equal(b.worthIt.defaults, 'saved');
  const d1 = await app.store.getRecord('travel_defaults', userId);
  assert.ok(d1 && d1.experiencePrefs, 'saved to the account');
  assert.equal(d1.experiencePrefs.from, mine.ref);
  const learned = X.learn({ worth: ['Main experience'], notWorth: ['Hotel'] });
  for (const [k, v] of Object.entries(learned.prefs)) assert.deepEqual(d1.experiencePrefs[k], v, k);
  assert.ok(text((await owner.req(`/booking/${mine.ref}?worth=1`)).text).includes('Kept on this booking and saved to your account’s travel defaults for next time, as you asked.'));
  // The booking as the pages read it carries the answer.
  assert.deepEqual(app.engine.publicBooking(b).worthIt.worth, ['Main experience']);

  // The owner's form, with an answer from this booking already remembered, says before they answer what
  // each choice does to it.
  const again = text((await owner.req(`/booking/${mine.ref}`)).text);
  assert.ok(again.includes('An answer from this booking is already saved to your account’s travel defaults. Ticked, this answer replaces it; unticked, it is removed and this answer stays on this booking only.'), again.slice(again.indexOf('WHAT WAS ACTUALLY WORTH IT?'), again.indexOf('WHAT WAS ACTUALLY WORTH IT?') + 900));

  // A guest booking (made signed out) belongs to no account: the form promises no save and offers no
  // box; a tick posted anyway keeps it on the booking only, and the page says why in those words,
  // never "another account".
  const gpage = await guest.req(`/booking/${theirs.ref}`);
  const gpanel = gpage.text.match(/<section class="tb-panel tb-mem-worth" id="worth-it"[\s\S]*?<\/section>/)[0];
  assert.ok(text(gpanel).includes('This trip was booked without an account, and remembering needs an account that owns the booking, so your answer stays on this booking only.'), text(gpanel));
  assert.ok(!gpanel.includes('name="remember"') && !text(gpanel).includes('Ticked, it is saved'), 'no promise of a save to a guest booking');
  const g = await guest.req(`/booking/${theirs.ref}/worth-it`, { method: 'POST', form: [['worth', 'Food'], ['remember', '1']] });
  assert.equal(g.location, `/booking/${theirs.ref}?worth=1#worth-it`);
  const gb = await app.store.getBookingByRef(theirs.ref);
  assert.equal(gb.worthIt.defaults, 'guest');
  assert.ok(text((await guest.req(`/booking/${theirs.ref}?worth=1`)).text).includes('Kept on this booking only: this trip was booked without an account, and remembering needs an account that owns the booking, so nothing was saved to one.'));
  const d2 = await app.store.getRecord('travel_defaults', userId);
  assert.deepEqual(d2.experiencePrefs, d1.experiencePrefs, 'the guest\'s answer never reaches another account');
  // The guest signs in later as a new account: still a booking without an account, said the same way.
  assert.equal((await guest.req('/signup', { method: 'POST', form: { name: 'Grace Hopper', email: 'grace@example.com', password: 'correct horse battery', next: '/my-trips' } })).status, 303);
  const gb0 = await app.store.getBookingByRef(theirs.ref);
  assert.ok(!gb0.userId, 'the guest booked signed out');
  const gsigned = text((await guest.req(`/booking/${theirs.ref}`)).text);
  assert.ok(gsigned.includes('This trip was booked without an account') && !gsigned.includes('Ticked, it is saved'), 'signed in, a guest booking is still promised nothing');
  const ng = await guest.req(`/booking/${theirs.ref}/worth-it`, { method: 'POST', form: [['worth', 'Food'], ['remember', '1']] });
  assert.equal(ng.location, `/booking/${theirs.ref}?worth=1#worth-it`);
  assert.equal((await app.store.getBookingByRef(theirs.ref)).worthIt.defaults, 'guest');
  const saved = await app.store.listRecords('travel_defaults', { limit: 100 });
  assert.ok(!saved.some(r => r.experiencePrefs && r.experiencePrefs.from === theirs.ref), 'nothing saved to an account that did not book it');
  const gthanks = text((await guest.req(`/booking/${theirs.ref}?worth=1`)).text);
  assert.ok(gthanks.includes('Kept on this booking only: this trip was booked without an account') && !gthanks.includes('belongs to another account'), gthanks.slice(0, 200));
  // Another signed-in account holding the owner's booking link (a shared device): no promise, no box;
  // a tick posted anyway is 'not-owner', and the owner's remembered answer stays as it was.
  const other = client(app.base);
  const cookie = `txbk_${mine.ref}`;
  other.jar[cookie] = owner.jar[cookie];
  assert.equal((await other.req('/signup', { method: 'POST', form: { name: 'Linus T', email: 'linus@example.com', password: 'correct horse battery', next: '/my-trips' } })).status, 303);
  const opanel = (await other.req(`/booking/${mine.ref}`)).text.match(/<section class="tb-panel tb-mem-worth" id="worth-it"[\s\S]*?<\/section>/)[0];
  assert.ok(text(opanel).includes('Remembering needs you signed in as the account that booked this trip; you are signed in with another one, so your answer stays on this booking only.'));
  assert.ok(!opanel.includes('name="remember"') && !text(opanel).includes('Ticked, it is saved') && !text(opanel).includes('already saved to your account'), 'nothing promised or told about the owner\'s account');
  await other.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Hotel'], ['remember', '1']] });
  b = await app.store.getBookingByRef(mine.ref);
  assert.equal(b.worthIt.defaults, 'not-owner'); assert.equal(b.worthIt.earlier, 'kept');
  assert.deepEqual((await app.store.getRecord('travel_defaults', userId)).experiencePrefs, d1.experiencePrefs, 'only the owner changes their account');
  assert.ok(text((await other.req(`/booking/${mine.ref}?worth=1`)).text).includes('An answer from this booking saved earlier is still on the account that booked it: only that account, signed in, can change it.'));

  // The owner changes the answer with the box unticked: the answer from this booking they asked me to
  // remember is removed from the account (the latest word counts; nothing they did not ask to keep stays),
  // and the page says exactly that.
  const changed = await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Hotel']] });
  assert.equal(changed.location, `/booking/${mine.ref}?worth=1#worth-it`);
  b = await app.store.getBookingByRef(mine.ref);
  assert.equal(b.worthIt.defaults, 'not-asked'); assert.equal(b.worthIt.earlier, 'removed');
  const d3 = await app.store.getRecord('travel_defaults', userId);
  assert.ok(!d3 || !d3.experiencePrefs, 'the earlier answer is gone from the account');
  const removedPage = text((await owner.req(`/booking/${mine.ref}?worth=1`)).text);
  assert.ok(removedPage.includes('Kept on this booking only: you did not ask me to remember it. The answer from this booking you asked me to remember earlier is removed from your account’s travel defaults: I go by your latest answer.'), removedPage.slice(removedPage.indexOf('WHAT WAS'), removedPage.indexOf('WHAT WAS') + 600));
  // Ticked again, then changed with the box ticked: the new answer replaces the one saved before, said.
  await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['not', 'Hotel'], ['remember', '1']] });
  assert.equal((await app.store.getBookingByRef(mine.ref)).worthIt.earlier, null, 'nothing was saved from this booking before this one');
  await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['worth', 'Hotel'], ['remember', '1']] });
  b = await app.store.getBookingByRef(mine.ref);
  assert.equal(b.worthIt.defaults, 'saved'); assert.equal(b.worthIt.earlier, 'replaced');
  const d4 = (await app.store.getRecord('travel_defaults', userId)).experiencePrefs;
  for (const [k, v] of Object.entries(X.learn({ worth: ['Hotel'], notWorth: [] }).prefs)) assert.deepEqual(d4[k], v, `the latest answer is the one on the account: ${k}`);
  assert.ok(text((await owner.req(`/booking/${mine.ref}?worth=1`)).text).includes('saved to your account’s travel defaults for next time, as you asked. It replaces the answer from this booking you asked me to remember earlier.'));
  // Ticked with nothing I can use ("Other" only): the earlier answer from this booking is removed too.
  await owner.req(`/booking/${mine.ref}/worth-it`, { method: 'POST', form: [['other', 'It rained'], ['remember', '1']] });
  b = await app.store.getBookingByRef(mine.ref);
  assert.equal(b.worthIt.defaults, 'nothing'); assert.equal(b.worthIt.earlier, 'removed');
  assert.ok(!(await app.store.getRecord('travel_defaults', userId)).experiencePrefs);
  assert.ok(text((await owner.req(`/booking/${mine.ref}?worth=1`)).text).includes('so nothing was saved to your account. The answer from this booking you asked me to remember earlier is removed from your account’s travel defaults: I go by your latest answer.'));
  // A stranger can't answer for a booking that isn't theirs.
  const stranger = client(app.base);
  const s = await stranger.req(`/booking/${theirs.ref}/worth-it`, { method: 'POST', form: [['worth', 'Hotel']] });
  assert.notEqual(s.status, 303);
  assert.deepEqual((await app.store.getBookingByRef(theirs.ref)).worthIt.worth, ['Food']);
});

// The text a link's row or block says about it: from the nearest row, block or heading that holds it
// to the next one, so an over-the-maximum note beside the link (inline after it, or in its block before
// it) is read with it and a neighbour's is not.
function around(html, l) {
  const at = html.indexOf(l.raw), end = at + l.raw.length;
  const from = Math.max(...['<li', '<div class="tb-leak-block', '<h3'].map(o => html.lastIndexOf(o, at)));
  const next = Math.min(...['<li', '<div class="tb-leak-block', '<h3', '<section', '</ul>'].map(o => { const i = html.indexOf(o, end); return i < 0 ? html.length : i; }));
  return text(html.slice(from, next));
}
const pricedRaw = html => [...html.matchAll(/<a\b[^>]*?href="\/trip\/([^"?\/#]+)(\/review)?\?([^"#]*)(?:#[^"]*)?" data-total="(\d+)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map(m => ({ token: decodeURIComponent(m[1]), review: !!m[2], params: new URLSearchParams(m[3].replace(/&amp;/g, '&')), total: Number(m[4]), words: text(m[5]), raw: m[0] }));

test('a promo code on the link: the memories page and the review page\'s versions name the total with the code as the one seen, so no review they open says the trip dropped', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  await app.store.putRecord('promo', 'SAVE20', { code: 'SAVE20', type: 'amount', value: 2000, minTotal: 0, expiresAt: null, active: true, createdAt: clock.toISOString(), by: 'test' });
  const promo = await svc.promo('SAVE20');
  const { trip, token } = await goalTrip(app, { dest: 'cancun', nights: 3, acts: 3 });
  const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}&promo=SAVE20`;
  const coded = (await svc.price(trip.spec, { promo })).total;
  assert.ok(coded < trip.total, 'the code takes something off this trip');
  // A review that opens on the total it was told it would: the code applied is not a price that moved.
  const opens = async (href, total, label) => {
    const r = await c.req(href);
    assert.equal(r.status, 200, label);
    assert.equal(Number(r.text.match(/name="approvedTotal" value="(\d+)"/)[1]), total, `${label}: the review's total is the one the link named`);
    assert.doesNotMatch(text(r.text), /your trip dropped|less than when you last looked/, `${label}: no drop claimed for a code`);
  };
  // The memories page prices before the code and says what it takes off; its review link names the
  // total with the code as the one seen.
  const mp = await c.req(`/trip/${token}/memories?${cxq}`);
  assert.equal(mp.status, 200);
  assert.ok(text(mp.text).includes(`Promo code SAVE20 goes with you to every version you open from here: ${money(trip.total - coded)} off this trip, so ${money(coded)} with it.`));
  const book = mp.text.match(/<a class="btn btn-ghost" href="(\/trip\/[^"]+\/review\?[^"]+)">Review and book/)[1].replace(/&amp;/g, '&');
  const bq = new URLSearchParams(book.split('?')[1]);
  assert.equal(bq.get('promo'), 'SAVE20'); assert.equal(Number(bq.get('seen')), coded);
  await opens(book, coded, 'Review and book');
  // The review page, with the code: every version its experience panels link to a review of is priced
  // with the code, shown at that total, and names it as the one seen.
  const review = await c.req(`/trip/${token}/review?${cxq}&seen=${coded}`);
  assert.equal(review.status, 200);
  const panels = review.text.slice(review.text.indexOf('<div class="tb-mem-review">'), review.text.indexOf('<form class="tb-confirm"'));
  const toReview = pricedRaw(panels).filter(l => l.review);
  assert.ok(toReview.length >= 1, 'the very scheduled line links to the review of a version with a day opened up');
  for (const l of toReview) {
    const p = await svc.price(decodeSpec(l.token), { promo });
    assert.equal(l.total, p.total, `${l.words}: the amount is the version's total with the code`);
    assert.ok(l.words.includes(money(p.total)), l.words);
    assert.equal(Number(l.params.get('seen')), l.total, `${l.words}: the amount shown is the one seen`);
    assert.equal(l.params.get('promo'), 'SAVE20');
    await opens(`/trip/${l.token}/review?${l.params.toString()}`, l.total, l.words);
  }
  assert.ok(!text(panels).includes('Priced before your promo code'), 'nothing on the review is priced before the code it shows');
});

test('the maximum is a ceiling, not a target: every version over it on the memories page says so beside its link, no block over it is the pick, and MAKE $100 MEMORABLE picks within it', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  let overSeen = 0, pickMoved = 0;
  for (const [dest, goals] of [['cancun', ['beach', 'food', 'nature']], ['lisbon', ['food', 'culture']], ['punta-cana', ['beach', 'adventure']], ['honolulu', ['nature', 'adventure']]]) {
    const { trip, token } = await goalTrip(app, { dest, nights: 5, acts: 2, goals, style: 'surprise' });
    // A ceiling $40 above the trip: most versions on the page go over it.
    const cap = (Math.ceil(trip.total / 100) + 40) * 100;
    const cxq = `b=${cap / 100}&mem=${goals.join(',')}`;
    const page = await c.req(`/trip/${token}/memories?${cxq}`);
    assert.equal(page.status, 200, dest);
    const body = page.text;
    // Every link to a version over the ceiling says by how much, beside it.
    for (const l of pricedRaw(body).filter(x => x.total > cap)) {
      overSeen++;
      assert.match(around(body, l), new RegExp(`${money(l.total - cap).replace(/[$.]/g, '\\$&')} over your ${money(cap).replace(/[$.]/g, '\\$&')} (?:ceiling|maximum)`), `${dest}: ${l.words} says it is over`);
    }
    // No block over the ceiling is marked as the pick (this trip is under it, so nothing over is excused).
    for (const block of body.match(/<div class="tb-leak-block is-pick">[\s\S]*?<\/div>/g) || []) for (const l of pricedRaw(block)) assert.ok(l.total <= cap, `${dest}: the pick ${l.words} fits`);
    // MAKE $100 MEMORABLE: the pick is the biggest difference among the versions that fit; a bigger one
    // over the ceiling is named as the traveler's call, never picked.
    const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq)));
    const mt = (await svc.memories(trip, cx, { amount: 10000 })).memoryTest;
    for (const x of mt.candidates) assert.equal(x.over, x.kind !== 'free' && x.total > cap, `${dest}: ${x.label} over is the total against the ceiling`);
    const fits = mt.candidates.filter(x => x.gain > 0 && !x.over), best = mt.candidates.find(x => x.gain > 0) || null;
    assert.equal(mt.pick, fits[0] || (best && !best.over ? best : null), `${dest}: the pick is the first that fits`);
    assert.ok(!mt.pick || !mt.pick.over, `${dest}: never a pick over the ceiling`);
    const said = text(section(body, 'make-memorable'));
    if (best && best.over) {
      pickMoved++;
      assert.ok(said.includes(`${best.label} (+${money(best.delta)})`) && said.includes(`${money(best.total - cap)} over your maximum; going over is your call.`), said.slice(0, 500));
    }
    if (mt.pick) {
      const row = (section(body, 'make-memorable').match(/<li data-kind="[^"]+" data-pick="1">[\s\S]*?<\/li>/) || [''])[0];
      assert.ok(text(row).includes(mt.pick.label), `${dest}: the pick's row is marked`);
      assert.ok(!/tb-mem-over/.test(row), `${dest}: the marked row is not over`);
    }
    // LOCATION recommends only a version that fits, and says the overage once, in the engine's words.
    const loc = section(body, 'location');
    assert.ok((text(loc).match(/over your \$[\d,.]+ maximum; within it/g) || []).length <= 1);
    assert.doesNotMatch(text(loc), /so it is yours to weigh; this trip stays under it/, 'no second over sentence');
  }
  assert.ok(overSeen > 0, 'versions over the ceiling were offered and checked');
  assert.ok(pickMoved > 0, 'a bigger difference over the ceiling was named as the traveler\'s call');
});

test('a protected experience the destination does not offer is dropped from every link and said in words, never as a raw id; one this version lacks keeps its line by name, and PROTECTION covers the trip\'s own main experience', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun', nights: 5, acts: 2 });
  const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`;
  const main = X.mainOf(trip, GOALS);
  const elsewhere = svc.inv.activities.search({ destId: 'lisbon' })[0].id;
  assert.ok(!trip.activityOptions.some(a => a.id === elsewhere), 'another destination\'s experience');
  const plainLadder = text(section((await c.req(`/trip/${token}/memories?${cxq}`)).text, 'ladder'));
  const NOTE = `The experience this link protects is not offered in ${trip.dest.name}, so it is no longer protected and nothing on this trip is held for it.`;
  for (const px of [elsewhere, 'zzz-made-up']) {
    for (const path of [`/trip/${token}/memories`, `/trip/${token}`, `/trip/${token}/review`]) {
      const r = await c.req(`${path}?${cxq}&px=${px}${path.endsWith('review') ? '&seen=0' : ''}`);
      assert.equal(r.status, 200, `${path} px=${px}`);
      const plain = text(r.text);
      assert.ok(plain.includes(NOTE), `${path} px=${px}: said in words`);
      assert.ok(!plain.includes(px), `${path} px=${px}: the id is never shown`);
      assert.ok(!r.text.includes(`px=${px}`), `${path} px=${px}: no link carries it on`);
      assert.doesNotMatch(plain, /MAIN EXPERIENCE 🔒 PROTECTED/, `${path}: nothing is protected`);
    }
    const mp = await c.req(`/trip/${token}/memories?${cxq}&px=${px}`);
    // Nothing else changes: the ladder is the one the page shows without it, and PROTECTION checks the
    // trip's own main experience.
    assert.equal(text(section(mp.text, 'ladder')), plainLadder, `px=${px}: the ladder is unchanged`);
    const prot = text(section(mp.text, 'protection'));
    assert.ok(prot.includes(`${main.name}, this trip's main experience`), prot.slice(0, 300));
    assert.ok(!prot.includes('This trip has no paid experience yet'));
  }
  // Offered in Cancun but not in this version: the missing line names it, the way back is there, and
  // PROTECTION checks the main experience this version has, saying why.
  const offered = trip.activityOptions.find(a => !trip.spec.activities.includes(a.id));
  for (const path of [`/trip/${token}/memories`, `/trip/${token}`]) {
    const plain = text((await c.req(`${path}?${cxq}&px=${offered.id}`)).text);
    assert.ok(plain.includes(`MAIN EXPERIENCE 🔒 PROTECTED: ${offered.name} is not in this version of the trip. Add it back or unprotect it`), path);
    assert.ok(!plain.includes(offered.id));
  }
  const prot = text(section((await c.req(`/trip/${token}/memories?${cxq}&px=${offered.id}`)).text, 'protection'));
  assert.ok(prot.includes(`${main.name}, this trip's main experience`) && prot.includes(`The protected experience, ${offered.name}, is not in this version, so these rows check the main experience it has.`), prot.slice(0, 400));
  const e = await svc.experienceReview(trip, { ...optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq))), protect: offered.id });
  assert.equal(e.main.id, main.id); assert.equal(e.missing.id, offered.id); assert.ok(e.protection.rows.length);
});

test('"Protect this instead": one experience is protected, another\'s control names the one it replaces and the page it opens says the switch; "Why this trip is built this way" lands where the receipt is', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base);
  const { trip, token } = await goalTrip(app, { dest: 'cancun', nights: 5, acts: 2 });
  const [A, B] = trip.activities;
  const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`;
  const tp = (await c.req(`/trip/${token}?${cxq}&px=${A.id}`)).text;
  const m = tp.match(new RegExp(`<a href="([^"]+)" data-protect="${B.id}" data-replaces="${A.id}">([\\s\\S]*?)</a>\\s*<small>([\\s\\S]*?)</small>`));
  assert.ok(m, 'B\'s control replaces A');
  assert.equal(text(m[2]).trim(), 'Protect this instead');
  assert.equal(text(m[3]).trim(), `(${A.name} is then no longer protected)`);
  assert.ok(!new RegExp(`data-protect="${B.id}">[\\s\\S]{0,400}?Protect this experience`).test(tp), 'never a plain "Protect this experience" while another is protected');
  const href = m[1].replace(/&amp;/g, '&');
  const hq = new URLSearchParams(href.split('?')[1].split('#')[0]);
  assert.equal(hq.get('px'), B.id); assert.equal(hq.get('pxwas'), A.id);
  const land = await c.req(href.split('#')[0]);
  const plain = text(land.text);
  assert.ok(plain.includes(`${B.name} is now the experience I protect; ${A.name} is no longer protected.`), 'the switch is said');
  assert.ok(plain.includes(`MAIN EXPERIENCE 🔒 PROTECTED: ${B.name}.`));
  // The note is said once: no link out of the landing carries the switch on, except A's own
  // "instead" control, which now names B as the one it would replace.
  for (const x of land.text.matchAll(/href="([^"]*pxwas=[^"]*)"/g)) assert.equal(new URLSearchParams(x[1].replace(/&amp;/g, '&').split('?')[1].split('#')[0]).get('pxwas'), B.id);
  assert.ok(!text((await c.req(`/trip/${token}?${cxq}&px=${B.id}`)).text).includes('is now the experience I protect'), 'only the switching link says it');
  assert.ok(!text((await c.req(`/trip/${token}?${cxq}&px=${B.id}&pxwas=zzz-made-up`)).text).includes('is now the experience I protect'), 'a pxwas naming nothing offered is ignored');
  // With nothing protected the controls are the plain "Protect this experience".
  assert.equal((tp.match(/data-replaces=/g) || []).length, trip.activities.length - 1);
  // The receipt button: with goals it lands on the receipt the memories page has; without goals there
  // is no receipt to land on, so the trip page asks for the goals instead.
  for (const [q, anchor, words] of [[cxq, 'receipt', 'Why this trip is built this way'], [`b=${budgetFor(trip) / 100}`, 'goals', 'Tell me what you want to remember']]) {
    const page = (await c.req(`/trip/${token}?${q}`)).text;
    const link = [...page.matchAll(/<a class="btn btn-ghost btn-sm" href="(\/trip\/[^"]+\/memories\?[^"]*#(?:receipt|goals))">([\s\S]*?)<\/a>/g)].map(x => ({ href: x[1].replace(/&amp;/g, '&'), words: text(x[2]).trim() }));
    assert.deepEqual(link.map(x => [x.href.split('#')[1], x.words]), [[anchor, words]], q);
    assert.ok((await c.req(link[0].href.split('#')[0])).text.includes(`id="${anchor}"`), `${q}: #${anchor} exists where it lands`);
  }
});

test('customer text on the memories and review pages writes dates the way the pages do and never doubles a stop', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  // Three experiences in three nights: a schedule conflict joined into the final check's sentence.
  const { trip, token } = await goalTrip(app, { dest: 'cancun', nights: 3, acts: 3 });
  const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`;
  const d = await svc.memories(trip, optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq))));
  // At the source: the engine's own words carry no ISO date (the protection rows name the departure) and a sentence joined
  // into the final check's keeps one stop, so the agent, which prints them raw, says them as the pages do.
  // (Availability names the day the rhythm gives the main experience, or the full days when it has none: never the arrival day.)
  const avail = d.protection.rows.find(r => r.key === 'availability').value, onDay = d.rhythm.placed.find(p => p.activity.id === d.main.id);
  assert.ok(avail.includes(longDate(onDay ? onDay.day.date : d.rhythm.days.find(x => x.full).date)) && !avail.includes(longDate(trip.spec.depart)), avail);
  assert.doesNotMatch(d.protection.rows.find(r => r.key === 'availability').value, /\d{4}-\d{2}-\d{2}/);
  assert.ok(!d.finalCheck.ok && d.finalCheck.reasons.some(r => !r.ok && /\.$/.test(r.text)), 'a reason that ends its own sentence is joined');
  assert.doesNotMatch(d.finalCheck.text, /\.\.|\.;/, 'the engine joins it with one stop');
  for (const path of [`/trip/${token}/memories?${cxq}`, `/trip/${token}/review?${cxq}&seen=0`]) {
    const plain = text((await c.req(path)).text);
    assert.doesNotMatch(plain, /\b\d{4}-\d{2}-\d{2}\b/, `${path}: no raw date`);
    assert.doesNotMatch(plain, /[^.]\.\.(?!\.)|\.;/, `${path}: no doubled stop`);
    assert.ok(plain.includes(longDate(trip.spec.depart)), `${path}: the trip's dates as the page writes them`);
  }
});

test('a protection the link carries, the customer\'s or the agent\'s from the results, is "the protected experience" on every page, never one "you protected"', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base);
  const { trip, token } = await goalTrip(app, { dest: 'cancun', nights: 5, acts: 2 });
  const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`, main = X.mainOf(trip, GOALS), offered = trip.activityOptions.find(a => !trip.spec.activities.includes(a.id));
  // The agent's canvas links carry px= for a protection it set itself; no page can tell, so no page says who set it.
  const YOU = /\byou protected\b|\bwhich you protected\b|\byour link protected\b|\bone you asked for\b/;
  const said = {};
  for (const [px, which] of [[main.id, 'in'], [offered.id, 'missing']]) for (const p of ['memories', '', 'review', 'leaks', 'optimize']) {
    const url = `/trip/${token}${p ? `/${p}` : ''}?${cxq}&px=${px}${p === 'review' ? '&seen=0' : ''}`, r = await c.req(url);
    assert.equal(r.status, 200, url);
    const plain = text(r.text); said[`${p || 'trip'} ${which}`] = plain;
    assert.doesNotMatch(plain, YOU, url);
  }
  assert.ok(said['memories in'].includes('The protected experience: no swap is offered for it.') && said['memories in'].includes(`${main.name}, the protected experience: what our data verifies`));
  assert.ok(said['leaks in'].includes(`${main.name} (the protected experience)`) && said['leaks in'].includes('Listed, not offered for removal: the protected experience'));
  assert.ok(said['memories missing'].includes(`The protected experience, ${offered.name}, is not in this version`) && said['memories missing'].includes(`Without ${offered.name}, the protected experience`));
  assert.ok(said['review missing'].includes(`without ${offered.name}, the protected experience`) && said['optimize missing'].includes(`without ${offered.name}, the protected experience`));
});

test('MAKE IT BETTER FOR $0 MORE: the versions that give something up have their own list under the free one, each with its trade-off and its own link, never mixed in', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  let seen = 0;
  for (const dest of ['cancun', 'punta-cana', 'lisbon', 'honolulu']) {
    const { trip, token } = await goalTrip(app, { dest, nights: 5, acts: 2, style: 'surprise' });
    const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`, cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq)));
    const mm = (await svc.memories(trip, cx)).more, more = section((await c.req(`/trip/${token}/memories?${cxq}`)).text, 'more');
    const list = name => (more.match(new RegExp(`<ul class="[^"]*" data-list="${name}">[\\s\\S]*?</ul>`)) || [''])[0];
    const rows = html => html.match(/<li data-kind="[^"]+">[\s\S]*?<\/li>/g) || [];
    // The free list holds only what gives nothing up; every row is one of the engine's free versions.
    assert.equal(rows(list('free')).length, mm.free.length, dest);
    for (const li of rows(list('free'))) assert.doesNotMatch(text(li), /gives up|trade-off/, `${dest}: nothing given up in the free list`);
    if (!mm.givesUp.length) { assert.ok(!more.includes('data-list="gives-up"') && !text(more).includes('Each of these gives something up'), dest); continue; }
    seen++;
    const plain = text(more), gives = list('gives-up');
    const freeAt = more.indexOf('data-list="free"'), givesAt = more.indexOf('data-list="gives-up"');
    assert.ok(plain.includes('Each of these gives something up') && givesAt > 0 && (freeAt < 0 || givesAt > more.indexOf('</ul>', freeAt)), `${dest}: its own list, under the free one`);
    assert.equal(rows(gives).length, mm.givesUp.length, dest);
    rows(gives).forEach((li, i) => {
      const g = mm.givesUp[i], links = priced(li);
      assert.ok(g.givesUp.length && text(li).includes(`the trade-off${g.givesUp.length > 1 ? 's' : ''}: ${g.givesUp.length === 1 ? g.givesUp[0] : `${g.givesUp.slice(0, -1).join(', ')} and ${g.givesUp[g.givesUp.length - 1]}`}`), `${dest}: the trade-off in words: ${text(li)}`);
      assert.equal(links.length, 1, `${dest}: its own link`); assert.equal(links[0].token, g.token); assert.equal(links[0].total, g.total);
      assert.ok(links[0].words.startsWith('See it') && g.total <= trip.total, `${dest}: at or under this trip`);
    });
    if (!mm.free.length) assert.ok(plain.includes('makes this trip more memorable by what you told me with nothing given up.'), plain.slice(0, 300));
    await checkPriced(svc, priced(gives), `${dest} gives-up`);
  }
  assert.ok(seen > 0, 'a version that gives something up was listed');
});

// G (page side): the locks the traveler set with the agent ride on every link as `locked=hotel,flight` (the known lock names
// only, in one order), the experience and leak pages read them into the engines' locks, and no link on the memories, leaks
// or review page opens a version that moves a locked hotel or flights. The ceiling (b=) is carried to the cent, never
// rounded up: $1,999.50 read back as $2,000 would let a page offer a version over the maximum.
test('G: locked= carries the agent\'s hotel and flight locks to every page link, no page offers a version across them, and b= keeps the ceiling\'s cents', async t => {
  const ctx = optimizer.parseContext({ b: '1999.50', locked: 'flight,bogus,hotel', mem: 'beach' });
  assert.equal(ctx.budget, 199950, 'the cents are read');
  assert.deepEqual(ctx.locks, { hotel: true, flight: true }, 'only the known lock names');
  const back = new URLSearchParams(optimizer.contextParams(ctx));
  assert.equal(back.get('b'), '1999.50'); assert.equal(back.get('locked'), 'hotel,flight');
  assert.deepEqual(optimizer.parseContext(Object.fromEntries(back)).locks, ctx.locks, 'the round trip keeps the locks');
  for (const cents of [200000, 199950, 199901, 10000]) assert.equal(optimizer.parseContext(Object.fromEntries(new URLSearchParams(optimizer.contextParams({ budget: cents })))).budget, cents, `${cents} cents round-trip exactly`);
  assert.ok(optimizer.parseContext({ b: '1999.999' }).budget <= 199999, 'never rounded up');
  assert.equal(new URLSearchParams(optimizer.contextParams({ budget: 200000, locks: ['flight', 'hotel'] })).get('locked'), 'hotel,flight', 'a list from the agent reads the same');
  assert.equal(new URLSearchParams(optimizer.contextParams({ budget: 200000 })).get('locked'), null, 'no lock, no parameter');

  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base);
  const { trip, token } = await goalTrip(app, { dest: 'cancun', acts: 1 });
  const cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`;
  for (const lk of ['hotel', 'flight', 'hotel,flight']) {
    let moved = 0, offered = 0;
    for (const page of ['memories', 'leaks', 'review']) {
      const html = (await c.req(`/trip/${token}/${page}?${cxq}&locked=${lk}${page === 'review' ? '&seen=0' : ''}`)).text;
      const links = [...html.matchAll(/href="\/trip\/([^"?\/#]+)(?:\/[a-z]+)?\?([^"#]*)/g)].map(m => ({ token: decodeURIComponent(m[1]), params: new URLSearchParams(m[2].replace(/&amp;/g, '&')) }));
      for (const l of links) {
        let s; try { s = decodeSpec(l.token); } catch (e) { continue; }
        offered++;
        assert.equal(l.params.get('locked'), lk, `${page}: every link carries the locks (${l.token})`);
        if ((lk.includes('hotel') && s.hotel !== trip.spec.hotel) || (lk.includes('flight') && s.flight !== trip.spec.flight)) moved++;
      }
    }
    assert.ok(offered > 10, `the pages link versions (${offered})`);
    assert.equal(moved, 0, `no link moves the ${lk} the traveler locked`);
  }
  // Without the locks the same pages do offer other hotels or flights: the parameter is what holds them.
  const free = (await c.req(`/trip/${token}/memories?${cxq}`)).text;
  assert.ok([...free.matchAll(/href="\/trip\/([^"?\/#]+)\?/g)].some(m => { try { const s = decodeSpec(decodeURIComponent(m[1])); return s.hotel !== trip.spec.hotel || s.flight !== trip.spec.flight; } catch (e) { return false; } }), 'unlocked, the page compares other hotels or flights');
  const mem = (await c.req(`/trip/${token}/memories?${cxq}&locked=hotel`)).text;
  assert.match(text(section(mem, 'location')), /The hotel is locked, so no other hotel is priced for its location/);
  // The trip page's own lock boxes show the agent's lock as set, and the optimize page holds it whatever the boxes say.
  const tp = (await c.req(`/trip/${token}?${cxq}&locked=hotel`)).text;
  assert.match(tp, /<input type="checkbox" name="lk" value="h" checked disabled> [\s\S]*?\(locked with your agent\)<\/label>/);
  const opt = await c.req(`/trip/${token}/optimize?${cxq}&locked=hotel&lk=d&cap=budget`);
  assert.equal(opt.status, 200);
  for (const m of opt.text.matchAll(/href="\/trip\/([^"?\/#]+)\?/g)) { let s; try { s = decodeSpec(decodeURIComponent(m[1])); } catch (e) { continue; } assert.equal(s.hotel, trip.spec.hotel, 'the optimize page keeps the agent\'s hotel lock'); }
});

// C and E: the agent's EXPERIENCE PROTECTION card stacks on a phone as the pages' PROTECTION does (it kept three columns at
// 390px, "What we know" a word or two a line), and a signed amount in a lettered version list never breaks after its sign
// ("−" alone at a line's end, "$68.12" on the next). The 390px Playwright probe checks the same page in a browser.
test('C + E: the agent\'s protection card is a stacking table on a phone; signed amounts in version lists stay on one line', async t => {
  const AG = '@media (max-width: 720px)';
  assert.equal(decl('.ag-protect-table tr', 'display', AG), 'grid', 'each row stacks on a phone');
  assert.equal(decl('.ag-protect-table td:nth-child(2)', 'grid-column', AG), '1 / -1', 'what we know takes the card\'s width');
  assert.equal(decl('.ag-protect-table td:nth-child(3)', 'grid-row', AG), '1', 'the status sits beside the check');
  assert.match(decl('.ag-protect-table thead', 'clip-path', AG) || '', /inset/, 'the header row stays for screen readers');
  assert.equal(decl('.ag-amt', 'white-space'), 'nowrap', 'a signed amount keeps its sign');
  assert.equal(decl('.ag-x-list li', 'grid-template-columns', AG), '26px minmax(0, 1fr)', 'the words keep the card\'s width; the button goes under them');

  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, visitor = 'v-ce-layout-0016';
  const s0 = await agent.create({ visitor, mission: true, mode: 'experience' });
  const say = async w => { await agent.say(s0.id, w, {}); await agent.jobs.drain(); return agent.load(s0.id); };
  await say('$2,000'); await say('Amazing beach and incredible food'); await say('Two of us from NYC');
  await say('Make it better for $0 more'); await say('Make $250 memorable');
  const canvas = await app.tripService.price(decodeSpec((await agent.load(s0.id)).current.token));
  const s = await say(`Protect ${X.mainOf(canvas, ['beach', 'food']).name}`);
  assert.ok(s.messages.some(m => m.card && m.card.kind === 'protection'), 'the protection card is shown');
  const c = client(app.base); c.jar.txv = visitor;
  const page = (await c.req(`/agent/${s0.id}`)).text;
  const card = page.slice(page.lastIndexOf('<div class="ag-card ag-protection">'));
  assert.match(card, /<table class="ag-receipt-table ag-protect-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Check<\/th><th scope="col" role="columnheader">What we know<\/th><th scope="col" role="columnheader" class="ag-num">Status<\/th><\/tr><\/thead>/);
  const rows = card.slice(0, card.indexOf('</table>')).match(/<tr role="row" class="is-(?:ok|verify)" data-key="[a-z]+">[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 8, 'every protection row'); for (const r of rows) assert.equal((r.match(/<td role="cell"/g) || []).length, 3);
  // What the list shows (a hidden say-field repeats the label as data, never on screen).
  const lists = [...page.matchAll(/<ol class="ag-bp-list ag-x-list">([\s\S]*?)<\/ol>/g)].map(m => m[1].replace(/<input[^>]*>/g, ''));
  assert.ok(lists.length, 'a lettered version list is shown');
  let amounts = 0;
  for (const l of lists) for (const m of l.matchAll(/(<(?:span|b) class="ag-amt">)?[−+–-]\s?\$[\d,]+(?:\.\d{2})?/g)) { amounts++; assert.ok(m[1], `a signed amount sits in .ag-amt: …${l.slice(Math.max(0, m.index - 40), m.index + 20)}`); }
  assert.ok(amounts > 0, 'the lists show signed amounts');
});

// The event on a link (ev=, evt=, evn=): the date the traveler built the trip around with the agent, the time slot only
// when they said one, and a short name. The Memories and review pages read it into the engines' o.event, so THE RHYTHM's
// EVENT DAY holds no experience, SCHEDULE CONFLICT and the FINAL EXPERIENCE CHECK read it, and every link the pages build
// carries it on. Odd values are dropped, never a 500: a date that is not a calendar date, a slot outside the engine's
// names, a name's markup; an event far from the trip, or already past, is dropped from every link and said in words.
test('the event on a link: the pages draw its EVENT DAY with no experience on it and carry it on; odd values are dropped, never a 500; a far or past one is said', async t => {
  const P = (q) => optimizer.parseContext(q).event;
  assert.deepEqual(P({ ev: '2026-11-10', evt: 'Evening', evn: 'your concert' }), { name: 'your concert', date: '2026-11-10', slot: 'evening' });
  assert.equal(P({ ev: '2026-02-30' }), null, 'not a calendar date');
  assert.equal(P({ ev: '10 Nov 2026' }), null, 'not an ISO date');
  assert.equal(P({ evt: 'evening', evn: 'your concert' }), null, 'no date, no event');
  assert.deepEqual(P({ ev: ['2026-11-10', '2026-12-01'], evt: 'noon' }), { name: null, date: '2026-11-10', slot: null }, 'the first value; a slot outside the names is no slot');
  const odd = P({ ev: '2026-11-10', evn: '<script>alert(1)</script> "Night" at the Arena, with friends & family and more words' });
  assert.ok(odd.name.length <= 40 && !/[<>"()]/.test(odd.name), `the name keeps plain words, at most 40 characters: ${odd.name}`);
  for (const ev of [{ name: 'your concert', date: '2026-11-10', slot: 'morning' }, { name: null, date: '2026-11-10', slot: null }]) assert.deepEqual(optimizer.parseContext(Object.fromEntries(new URLSearchParams(optimizer.contextParams({ budget: 200000, event: ev })))).event, ev, 'the round trip keeps it');
  assert.equal(new URLSearchParams(optimizer.contextParams({ budget: 200000, event: { name: 'x', date: 'soon' } })).get('ev'), null, 'an event without a readable date is never written');

  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { trip, token } = await goalTrip(app, { dest: 'cancun', acts: 2 });
  const names = trip.activities.map(a => a.name), cxq = `b=${budgetFor(trip) / 100}&mem=${GOALS.join(',')}`;
  // The event on a day the rhythm gives an experience when it is not there: the day the event must take from it.
  const hit = X.rhythm(trip, GOALS).placed[0];
  assert.ok(hit, 'fixture: the rhythm places an experience on a full day');
  const date = hit.day.date, on = longDate(date), evq = `ev=${date}&evn=${encodeURIComponent('your concert')}`;
  const rows = html => [...html.matchAll(/<li class="([^"]*)" data-day="(\d+)" data-label="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].map(m => ({ cls: m[1].split(' '), n: Number(m[2]), label: m[3], text: text(m[4]) }));
  const day = (html, n) => rows(html).find(d => d.n === n);
  const evLinks = html => [...html.matchAll(/href="(\/trip\/[^"#]+)/g)].map(m => new URLSearchParams((m[1].split('?')[1] || '').replace(/&amp;/g, '&')).get('ev'));
  const before = (await c.req(`/trip/${token}/memories?${cxq}`)).text;
  assert.ok(names.some(n => day(before, hit.day.n).text.includes(n)), 'fixture: without the event an experience is on that day');
  const mem = await c.req(`/trip/${token}/memories?${cxq}&${evq}`);
  assert.equal(mem.status, 200);
  const row = day(mem.text, hit.day.n);
  assert.equal(row.label, 'Event day'); assert.ok(row.cls.includes('is-event') && row.text.includes('Your concert'), JSON.stringify(row));
  assert.ok(!names.some(n => row.text.includes(n)), `no experience on the event's day: ${JSON.stringify(row)}`);
  const page = text(mem.text);
  assert.ok(page.includes(`Your concert on ${on} has its day to itself`) || page.includes(`${on} is the day of your concert`), 'the final check and the conflicts read the event');
  const carried = evLinks(mem.text);
  assert.ok(carried.length > 10 && carried.every(v => v === date), 'every link on the page carries the event on');
  assert.doesNotMatch(page, PRESSURE); assert.doesNotMatch(page, /undefined|NaN|\bnull\b|\[object/);
  // The review page reads it too, and its links carry it.
  const rv = await c.req(`/trip/${token}/review?${cxq}&${evq}&seen=0`);
  assert.equal(rv.status, 200);
  const fc = text(section(rv.text, 'final-check'));
  assert.ok(fc.includes(`Your concert on ${on} has its day to itself`) || fc.includes(`${on} is the day of your concert`), fc);
  assert.ok(evLinks(rv.text).every(v => v === date), 'every link on the review page carries the event on');
  // A slot the traveler said rides along, and a name's markup never reaches the page as markup.
  const sl = await c.req(`/trip/${token}/memories?${cxq}&ev=${date}&evt=evening&evn=${encodeURIComponent('<b>the show</b>')}`);
  assert.equal(sl.status, 200);
  const shown = optimizer.parseContext({ ev: date, evn: '<b>the show</b>' }).event.name;
  assert.ok(shown && day(sl.text, hit.day.n).text.includes(`${shown.charAt(0).toUpperCase()}${shown.slice(1)} (evening)`), `the event is named with the time said: ${JSON.stringify(day(sl.text, hit.day.n))}`);
  assert.ok(!sl.text.includes('<b>the show</b>') && evLinks(sl.text).length && evLinks(sl.text).every(v => v === date));
  // Odd values: dropped, the page as without an event, never a 500.
  for (const q of ['ev=2026-02-30&evt=evening', 'ev=tomorrow&evn=x', `ev=${date}x`, 'evt=evening&evn=your+concert', 'ev=%00&evt=%3Cscript%3E']) {
    for (const p of ['memories', 'review', 'leaks']) {
      const r = await c.req(`/trip/${token}/${p}?${cxq}&${q}${p === 'review' ? '&seen=0' : ''}`);
      assert.equal(r.status, 200, `${p}?${q}`);
      assert.ok(!/\bis-event\b/.test(r.text) && evLinks(r.text).every(v => v === null), `${p}?${q}: no event read or carried`);
    }
  }
  // Far from the trip, or already past: dropped from every link and said, never read as this trip's reservation.
  const far = addDays(trip.spec.depart, trip.spec.nights + 31), past = addDays(today(clock), -1);
  assert.ok(svc.eventFor(trip, { event: { date: addDays(trip.spec.depart, trip.spec.nights + 30) } }), 'thirty days after the trip is near');
  assert.equal(svc.eventFor(trip, { event: { date: far } }), null, 'thirty-one days after is not');
  for (const [d, words] of [[far, 'is more than 30 days from this trip\'s dates'], [past, 'is already past']]) {
    for (const p of ['memories', 'review']) {
      const r = await c.req(`/trip/${token}/${p}?${cxq}&ev=${d}&evn=your+concert${p === 'review' ? '&seen=0' : ''}`);
      assert.equal(r.status, 200);
      const note = (r.text.match(/<p [^>]*data-event-note[^>]*>([\s\S]*?)<\/p>/) || [])[1];
      assert.ok(note && text(note).includes(`(your concert on ${longDate(d)}) ${words}`) && text(note).includes('so this page does not plan around it'), `${p} ${d}: ${note}`);
      assert.ok(!/\bis-event\b/.test(r.text) && evLinks(r.text).every(v => v === null), `${p} ${d}: not read, not carried`);
    }
  }
});
