// The plan §A3 flows over real HTTP, as a person clicks them on a local preview: shared by business-e2e.test.js
// and business-nobooking.test.js (not a test file itself: it doesn't match *.test.js). Every form is read from
// the page and posted with the fields a browser sends, through a cookie jar, with same-origin fetch metadata
// and no automatic redirects. The real modules throughout (createApp with Business on: demo inventory,
// TripComposer, the policy engine, alternatives, the rule explainer, D1 accounts); the clock is a
// mutableClock held at FIXED_NOW, so the trips and their demo prices are the same on every run.
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { mutableClock, storeSnapshot } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { createBusinessInventory } = require('../server/business/inventory');
const { overrideProvider } = require('./business-fakes');

const PASSWORD = 'correct horse battery';
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const BQ = Object.freeze({ ...Q, cabin: 'business' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';

// ---------------------------------------------------------------------------------------------------------
// Page helpers

const decode = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = s => decode(String(s).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const mainOf = page => (String(page).match(/<main\b[\s\S]*<\/main>/) || [''])[0];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const short = s => String(s).slice(0, 600);
// The experience engine's list (test/experience-pages.test.js): urgency, scarcity, predictions, guarantees.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;

/** Every <form action="..."> on the page, as its inner markup. */
function formsOf(page, action) {
  const re = new RegExp(`<form[^>]*action="${escRe(action)}"[^>]*>([\\s\\S]*?)</form>`, 'g');
  return [...String(page).matchAll(re)].map(m => m[1]);
}

/** The fields a browser sends for a form body: inputs, checked boxes and radios, selects, textareas. */
function fieldsOf(body) {
  const attr = (tag, name) => { const a = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return a ? decode(a[1]) : null; };
  const has = (tag, name) => new RegExp(`\\s${name}(\\s|>|=|$)`).test(tag);
  const out = [];
  for (const [tag] of String(body).matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    if (!name || has(tag, 'disabled')) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !has(tag, 'checked')) continue;
    out.push([name, attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : '')]);
  }
  for (const [, open, inner] of String(body).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(open, 'name');
    if (!name) continue;
    const opts = [...inner.matchAll(/<option\b([^>]*)>/g)].map(o => o[1]);
    const chosen = opts.find(o => has(o, 'selected')) || opts[0];
    out.push([name, chosen ? attr(chosen, 'value') ?? '' : '']);
  }
  for (const [, open, inner] of String(body).matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(open, 'name');
    if (name) out.push([name, decode(inner)]);
  }
  return out;
}

/** The fields of the first form posting to `action` (or the first one `pick` accepts). */
function formOf(page, action, pick = null) {
  const all = formsOf(page, action);
  const body = pick ? all.find(pick) : all[0];
  assert.ok(body, `a form posting to ${action}`);
  return fieldsOf(body);
}
const setField = (pairs, name, value) => (pairs.some(([k]) => k === name) ? pairs.map(([k, v]) => [k, k === name ? value : v]) : [...pairs, [name, value]]);
const setFields = (pairs, values) => Object.entries(values).reduce((p, [k, v]) => setField(p, k, v), pairs);
const getField = (pairs, name) => (pairs.find(([k]) => k === name) || [])[1];

/** The value of the <option> whose text starts with `label`, in the select named `name`. */
function optionValue(body, name, label) {
  const sel = new RegExp(`<select\\b[^>]*name="${escRe(name)}"[^>]*>([\\s\\S]*?)</select>`).exec(body);
  if (!sel) return null;
  for (const m of sel[1].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
    if (textOf(m[2]).startsWith(label)) return decode(m[1]);
  }
  return null;
}

/**
 * What every workspace page passes: a <main>, CSP-safe markup and a strict script CSP, no em dash, no pressure
 * words, nothing internal; and (demo) every amount shown inside a demo container that says "Demo price".
 * @returns {string} the page's <main>
 */
function pageChecks(label, res, { demo = true } = {}) {
  const page = res.text;
  const main = mainOf(page);
  assert.ok(main, `${label}: has <main>`);
  assert.doesNotMatch(page, /<style\b/, `${label}: no <style>`);
  assert.doesNotMatch(page, /\son[a-z]+\s*=\s*["']/i, `${label}: no on* handlers`);
  assert.doesNotMatch(page, /<script\b(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/, `${label}: no inline <script>`);
  assert.doesNotMatch(page, /\sstyle="/, `${label}: no inline style attribute`);
  assert.doesNotMatch(textOf(main), /—/, `${label}: no em dash`);
  assert.doesNotMatch(textOf(main), PRESSURE, `${label}: no pressure words`);
  assert.doesNotMatch(page, /supplierQuoteRef|netCents|netNightly|commission|markup|BusinessDemo|"internal"/i, `${label}: nothing internal`);
  const csp = res.headers.get('content-security-policy') || '';
  const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src')) || '';
  assert.ok(/script-src 'self'/.test(csp) && !/unsafe-inline/.test(scriptSrc), `${label}: strict script CSP (${csp})`);
  if (demo) {
    const amounts = (textOf(main).match(/\$\d/g) || []).length;
    if (amounts) {
      assert.ok(/data-price-source="demo"/.test(main) && /Demo price/.test(textOf(main)), `${label}: its ${amounts} amounts are shown as Demo price`);
    }
  }
  return main;
}

/** Cache-Control no-store and X-Robots-Tag noindex. */
const privateHeaders = r => /no-store/.test(r.headers.get('cache-control') || '') && /noindex/.test(r.headers.get('x-robots-tag') || '');

// ---------------------------------------------------------------------------------------------------------
// A browser: a cookie jar, same-origin fetch metadata, no automatic redirects.

function browser(base, extraHeaders = {}) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = res => {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      const gone = value === '' || attrs.some(a => /^\s*max-age=0\s*$/i.test(a))
        || attrs.some(a => /^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now());
      if (gone) jar.delete(name); else jar.set(name, value);
    }
  };
  const req = async (path, { method = 'GET', pairs = null, headers = {} } = {}) => {
    const h = { 'sec-fetch-site': 'same-origin', ...extraHeaders, ...headers };
    const c = cookie();
    if (c) h.cookie = c;
    let body;
    if (pairs) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(pairs).toString(); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    take(res);
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text(), path };
  };
  return {
    jar,
    get: (path, opts) => req(path, opts),
    post: (path, pairs, opts = {}) => req(path, { ...opts, method: 'POST', pairs: Array.isArray(pairs) ? pairs : Object.entries(pairs || {}) }),
    /** Follow 303/302 redirects with GETs, as a browser does. */
    async follow(res, max = 5) {
      let r = res;
      for (let i = 0; i < max && r.status >= 300 && r.status < 400 && r.location; i++) {
        const u = new URL(r.location, base);
        r = await req(u.pathname + u.search);
      }
      return r;
    },
  };
}

/** The enabled radio choices on a results page: { name, value, state, card, kind }. */
function choices(page) {
  const out = [];
  for (const art of String(page).matchAll(/<article class="bz-card bz-row bz-row-(hotel|flight)"[\s\S]*?<\/article>/g)) {
    const card = art[0];
    for (const li of card.matchAll(/<li class="bz-opt([^"]*)">([\s\S]*?)<\/li>/g)) {
      const radio = /<input class="bz-opt-radio" type="radio"[^>]*name="([^"]+)" value="([^"]*)"([^>]*)>/.exec(li[2]);
      if (!radio || /\sdisabled/.test(radio[3])) continue;
      const state = (li[1].match(/is-(within|out|blocked|unavailable)/) || [])[1] || null;
      out.push({ name: radio[1], value: decode(radio[2]), state, card, kind: art[1] });
    }
  }
  return out;
}

/** A row key 'h.<offerId>|<optionId>' (or 'f.…') as its parts. */
function rowKeyParts(key) {
  const m = /^[fh]\.(.+)\|([^|]+)$/.exec(key);
  assert.ok(m, `a row key: ${key}`);
  return { offerId: m[1], optionId: m[2] };
}

// ---------------------------------------------------------------------------------------------------------
// Worlds

/**
 * Names for one run. With a tag (a Postgres run on a shared database), every email and company name carries
 * it, so reruns never collide.
 */
function namesFor(tag = '') {
  const dom = tag ? `${tag}.sample.example` : 'sample.example';
  return {
    tag,
    company: tag ? `Sample Company ${tag} (demo)` : 'Sample Company (demo)',
    second: tag ? `Second Sample Co ${tag}` : 'Second Sample Co',
    prodCompany: tag ? `Prod Sample Co ${tag}` : 'Prod Sample Co',
    opsEmail: tag ? `ops.${tag}@tripelyx.example` : 'ops@tripelyx.example',
    email: local => `${local}@${dom}`,
  };
}

/**
 * The development app (Business on, demo inventory) on a held clock, with the platform admin's address in
 * ADMIN_EMAILS. `store` defaults to a fresh MemoryStore; `env` adds config (a Postgres DATABASE_URL, say).
 * @returns {Promise<object>} w: { app, base, clock, names, close, ... } that the flows below fill in
 */
async function devWorld({ tag = '', env = {}, store, clock = mutableClock(FIXED_NOW) } = {}) {
  const names = namesFor(tag);
  const app = await startApp({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS: names.opsEmail, ...env }, { now: clock.now, ...(env.DATABASE_URL ? {} : { store: store || new MemoryStore() }) });
  const w = { app, base: app.base, clock, names, people: {}, rids: {} };
  w.close = async () => { await app.close(); if (app.store.kind !== 'memory') await app.store.close(); };
  return w;
}

/** The production config (APP_ENV=production, a dummy DATABASE_URL, trips off, Business on) on an injected MemoryStore. */
async function prodWorld({ tag = '', clock = mutableClock(FIXED_NOW) } = {}) {
  const names = namesFor(tag);
  const env = { APP_ENV: 'production', DATABASE_URL: 'postgres://e2e-unused@127.0.0.1:9/none', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' };
  const app = await startApp(env, { now: clock.now, store: new MemoryStore() });
  return { app, base: app.base, clock, names, close: () => app.close() };
}

// ---------------------------------------------------------------------------------------------------------
// A3 1: the site, /business, then "Create your company workspace": the Owner of a pending company.

async function signUpOwner(w) {
  const { names } = w;
  const owner = browser(w.base);
  let res = await owner.get('/');
  assert.equal(res.status, 200, 'GET /');
  assert.match(res.text, /<a[^>]*href="\/business"[^>]*>\s*Business\s*</, 'the header has the Business item');
  res = await owner.get('/business');
  assert.equal(res.status, 200, 'GET /business');
  assert.match(res.text, /href="\/business\/start"/, '/business links to /business/start');
  assert.match(textOf(res.text), /Company sign in|Sign in/, '/business has the company sign in');
  assert.ok(!privateHeaders(res), 'the /business marketing page is indexable');
  res = await owner.get('/business/start');
  assert.equal(res.status, 200);
  assert.match(textOf(res.text), /Create your company workspace/, '/business/start shows the sign-up form');
  assert.ok(privateHeaders(res), '/business/start is no-store and noindex');
  const pairs = setFields(formOf(res.text, '/business/start'), {
    name: 'Moataz Owner', email: names.email('moataz'), password: PASSWORD, companyName: names.company, size: '11-50 people', timezone: 'Africa/Cairo', ack: '1',
  });
  res = await owner.post('/business/start', pairs);
  assert.equal(res.status, 303, `POST /business/start: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /^\/business\/o\/[^/]+\/welcome$/, 'answers 303 to the welcome page');
  w.orgId = res.location.split('/')[3];
  w.B = `/business/o/${w.orgId}`;
  res = await owner.follow(res);
  pageChecks('welcome', res);
  assert.ok(privateHeaders(res), 'a workspace page is no-store and noindex');
  const all = textOf(res.text);
  assert.ok(all.includes(`Tripelyx is confirming ${names.company}`), 'the pending ribbon names the company');
  assert.match(all, /Preview: flights, hotels and prices are demo data\. Nothing is booked or charged\. No emails are sent\./, 'the demo ribbon');
  assert.match(all, /Owner/, 'the switcher shows the Owner role');
  assert.match(res.text, /bz-switch/, 'the company switcher is in the top bar');
  w.owner = owner;
  return owner;
}

// A3 2: the platform admin (ADMIN_EMAILS plus a platform_admin record, D1) confirms the company.

async function platformAdmin(w) {
  if (w.ops) return w.ops;
  const user = await w.app.accounts.register({ name: 'Pat Platform', email: w.names.opsEmail, password: PASSWORD });
  await w.app.accounts.grantPlatformAdmin(user.id, { by: 'test', note: 'e2e' });
  const ops = browser(w.base);
  let res = await ops.get('/business/signin');
  assert.equal(res.status, 200, 'GET /business/signin');
  res = await ops.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email: w.names.opsEmail, password: PASSWORD }));
  assert.equal(res.status, 303, `the platform admin signs in: ${short(textOf(mainOf(res.text)))}`);
  w.ops = ops;
  return ops;
}

async function confirmCompany(w, orgId, name) {
  const ops = await platformAdmin(w);
  let res = await ops.get('/admin/business');
  assert.equal(res.status, 200, `GET /admin/business: ${short(textOf(res.text))}`);
  assert.ok(privateHeaders(res), '/admin/business is no-store and noindex');
  assert.ok(textOf(res.text).includes(name), `${name} is listed`);
  const confirm = formsOf(res.text, `/admin/business/${orgId}/status`).find(f => /value="active"/.test(f));
  assert.ok(confirm, `a Confirm form for ${name}`);
  res = await ops.post(`/admin/business/${orgId}/status`, fieldsOf(confirm));
  assert.equal(res.status, 303, `POST status=active: ${short(textOf(mainOf(res.text)))}`);
  res = await ops.follow(res);
  assert.equal(res.status, 200, 'the list again');
  return res;
}

async function platformConfirm(w) {
  const { names, owner, B, orgId } = w;
  // Before the platform admin acts: the owner is no platform admin, and the company is pending.
  assert.equal((await owner.get('/admin/business')).status, 404, 'a company owner gets 404 on /admin/business');
  const ops = await platformAdmin(w);
  const list = await ops.get('/admin/business');
  assert.ok(textOf(list.text).includes(`Created by ${names.email('moataz')}`), 'the list says who created the company');
  await confirmCompany(w, orgId, names.company);
  const res = await owner.get(B);
  assert.equal(res.status, 200);
  assert.ok(!textOf(res.text).includes('Tripelyx is confirming'), 'the owner home no longer shows the pending ribbon');
  // The platform admin is not a member: a workspace URL is a 404.
  assert.equal((await ops.get(B)).status, 404, 'the platform admin gets 404 inside the company');
  const org = await w.app.store.getRecord('biz_org', orgId);
  const opsLink = await w.app.store.getRecord('user_email', names.opsEmail);
  assert.deepEqual([org.status, org.statusBy], ['active', opsLink.userId], 'confirmed by the platform admin');
}

// A3 3: policies (review the three tiers, edit one: v2 in history), departments with Q4 budgets.

async function policiesDepartmentsBudgets(w) {
  const { owner, B } = w;
  let res = await owner.get(`${B}/policies`);
  let main = pageChecks('/policies', res);
  for (const tier of ['Standard', 'Director', 'Executive']) assert.ok(textOf(main).includes(tier), `/policies lists ${tier}`);
  for (const tier of ['standard', 'director', 'executive']) {
    const r = await owner.get(`${B}/policies/${tier}`);
    assert.equal(r.status, 200, `/policies/${tier}`);
    pageChecks(`/policies/${tier}`, r);
  }
  res = await owner.get(`${B}/policies/director`);
  let pairs = formOf(res.text, `${B}/policies/director`);
  const newTotal = String((Number(getField(pairs, 'trip.maxTotal')) || 8000) + 500);
  pairs = setFields(pairs, { 'trip.maxTotal': newTotal, note: 'Raised the trip limit for client visits.' });
  res = await owner.post(`${B}/policies/director`, pairs);
  assert.equal(res.status, 303, `saving the Director policy: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\?ok=saved$/);
  res = await owner.follow(res);
  assert.match(textOf(res.text), /Saved as a new version/, 'the saved notice');
  res = await owner.get(`${B}/policies/director/history`);
  main = pageChecks('/policies/director/history', res);
  assert.match(textOf(main), /Version 2|v2\b/, 'the history shows version 2');
  assert.match(textOf(main), /Raised the trip limit for client visits\./, 'the history shows the note');
  assert.match(textOf(main), /Trip limit/, 'the history names the changed field');

  res = await owner.get(`${B}/people`);
  pageChecks('/people', res);
  for (const name of ['Sales', 'Engineering']) {
    const form = formsOf(res.text, `${B}/departments`).find(f => !/name="departmentId"/.test(f));
    assert.ok(form, 'an Add department form');
    const r = await owner.post(`${B}/departments`, setField(fieldsOf(form), 'name', name));
    assert.equal(r.status, 303, `adding ${name}: ${short(textOf(mainOf(r.text)))}`);
    res = await owner.follow(r);
  }
  assert.ok(textOf(res.text).includes('Sales') && textOf(res.text).includes('Engineering'), 'People lists both departments');

  res = await owner.get(`${B}/budgets?period=2026-Q4`);
  pageChecks('/budgets', res);
  w.deptIds = {};
  for (const [name, amount] of [['Sales', '15000'], ['Engineering', '30000']]) {
    const form = formsOf(res.text, `${B}/budgets`).find(f => textOf(f).includes(name));
    assert.ok(form, `a budget form for ${name}`);
    let fp = fieldsOf(form);
    w.deptIds[name] = getField(fp, 'departmentId');
    assert.equal(getField(fp, 'period'), '2026-Q4', `the ${name} budget form is for Q4 2026`);
    fp = setField(fp, 'amount', amount);
    const r = await owner.post(`${B}/budgets`, fp);
    assert.equal(r.status, 303, `the ${name} budget saves: ${short(textOf(mainOf(r.text)))}`);
    res = await owner.follow(r);
  }
  main = pageChecks('/budgets after', res);
  assert.ok(/\$30,000/.test(textOf(main)) && /\$15,000/.test(textOf(main)), 'both budgets show');
}

// A3 4: invites, each accepted in a fresh browser that creates its account.

async function inviteAndJoin(w, key, name, local, role, extra = {}) {
  const { owner, B, names } = w;
  const email = names.email(local);
  let r = await owner.get(`${B}/people`);
  const body = formsOf(r.text, `${B}/people/invite`)[0];
  assert.ok(body, `${key}: the invite form`);
  let fp = setFields(fieldsOf(body), { email, role });
  if (extra.department) fp = setField(fp, 'departmentId', optionValue(body, 'departmentId', extra.department) || '');
  if (extra.manager) {
    fp = setField(fp, 'managerId', optionValue(body, 'managerId', extra.manager) || '');
    assert.ok(getField(fp, 'managerId'), `${key}: the manager is offered in the invite form`);
  }
  r = await owner.post(`${B}/people/invite`, fp);
  assert.equal(r.status, 200, `${key}: the invite link page: ${r.location} ${short(textOf(mainOf(r.text)))}`);
  assert.ok(/no-store/.test(r.headers.get('cache-control') || '') && r.headers.get('referrer-policy') === 'no-referrer', `${key}: no-store and no-referrer on the link page`);
  assert.match(textOf(r.text), /We don't send email yet\./, `${key}: the page says no email is sent`);
  pageChecks(`${key} invite link`, r);
  const m = /\/business\/invite\/([A-Za-z0-9_-]{16,})/.exec(r.text);
  assert.ok(m, `${key}: the link is on the page`);
  const token = m[1];
  const b = browser(w.base);
  r = await b.get(`/business/invite/${token}`);
  assert.equal(r.status, 200);
  assert.match(textOf(r.text), /Create your account to join/, `${key}: the invite page offers "Create your account to join"`);
  assert.ok(textOf(r.text).includes(names.company), `${key}: the invite names the company`);
  assert.match(textOf(r.text), /\(Cairo time\)/, `${key}: the expiry is in the company's time`);
  r = await b.post(`/business/invite/${token}/join`, setFields(formOf(r.text, `/business/invite/${token}/join`), { name, password: PASSWORD }));
  assert.equal(r.status, 303, `${key}: join: ${short(textOf(mainOf(r.text)))}`);
  r = await b.follow(r);
  assert.equal(r.status, 200);
  assert.ok(r.path.startsWith(B), `${key}: lands in the company (${r.path})`);
  assert.equal((await browser(w.base).get(`/business/invite/${token}`)).status, 410, `${key}: the used link answers 410`);
  w.people[key] = { b, name, email };
  return b;
}

async function invites(w) {
  const { owner, B } = w;
  await inviteAndJoin(w, 'travelAdmin', 'Tara Travel', 'tara', 'travel_admin');
  await inviteAndJoin(w, 'manager', 'Dana Lee', 'dana', 'manager', { department: 'Engineering' });
  await inviteAndJoin(w, 'finance', 'Fay Finance', 'fay', 'finance');
  await inviteAndJoin(w, 'employee', 'Sam Rivera', 'sam', 'employee', { department: 'Engineering', manager: 'Dana Lee' });
  const res = await owner.get(`${B}/people`);
  const main = pageChecks('/people (five)', res);
  for (const n of ['Moataz Owner', 'Tara Travel', 'Dana Lee', 'Fay Finance', 'Sam Rivera']) assert.ok(textOf(main).includes(n), `People lists ${n}`);
  for (const role of ['Travel Admin', 'Manager', 'Finance', 'Employee']) assert.ok(textOf(main).includes(role), `People shows the ${role} role`);
  assert.equal((await w.people.travelAdmin.b.get(`${B}/people`)).status, 200, 'the Travel Admin opens People');
  const r = await w.people.finance.b.get(`${B}/approvals`);
  assert.equal(r.status, 403, 'Finance cannot open Approvals');
  assert.match(r.text, /class="bz-app"/, 'the role refusal is drawn inside the workspace');
  assert.ok(textOf(r.text).includes(`Back to ${w.names.company} home`), 'with a way back');
}

/** A3 1 to 4: a confirmed company with departments, Q4 budgets and five members, all over HTTP. */
async function company(w) {
  await signUpOwner(w);
  await platformConfirm(w);
  await policiesDepartmentsBudgets(w);
  await invites(w);
  return w;
}

// ---------------------------------------------------------------------------------------------------------
// A3 5: the Employee plans CAI to LHR with a return and a London hotel.

/** A search page as the employee, and the trip form's fields minus the picks. */
async function search(w, who, q) {
  const r = await who.get(`${w.B}/trips/search?${new URLSearchParams(q)}`);
  assert.equal(r.status, 200, `the search: ${short(textOf(mainOf(r.text)))}`);
  return r;
}

/** Review trip: POST /trips with the picks, then the draft page. */
async function reviewTrip(w, who, page, picks, purpose) {
  let fp = formOf(page, `${w.B}/trips`).filter(([k]) => !['out', 'back', 'hotelKey'].includes(k));
  fp.push(['out', picks.out], ['back', picks.back], ['hotelKey', picks.hotelKey]);
  fp = setField(fp, 'purpose', purpose);
  const r = await who.post(`${w.B}/trips`, fp);
  assert.equal(r.status, 303, `Review trip (${purpose}): ${short(textOf(mainOf(r.text)))}`);
  assert.match(r.location || '', /\/trips\/btr_/, 'to the draft');
  const rid = r.location.split('/').pop();
  return { rid, res: await who.follow(r) };
}

/** Within-policy picks on every leg (a 3-star London hotel). */
function withinPicks(page) {
  const ch = choices(page);
  const pick = name => ch.find(c => c.name === name && c.state === 'within');
  const hotel3 = ch.find(c => c.name === 'hotelKey' && c.state === 'within' && /3-star/.test(c.card));
  assert.ok(pick('out') && pick('back') && hotel3, `within-policy choices on each leg: ${JSON.stringify(ch.map(c => [c.name, c.state])).slice(0, 300)}`);
  return { out: pick('out').value, back: pick('back').value, hotelKey: hotel3.value };
}

/** A within-policy draft (not sent yet). */
async function withinDraft(w, purpose, who = w.people.employee.b) {
  const res = await search(w, who, Q);
  const picks = withinPicks(res.text);
  const { rid, res: draft } = await reviewTrip(w, who, res.text, picks, purpose);
  const main = pageChecks('draft within', draft);
  assert.match(textOf(main), /Every part of this trip is inside your policy/, 'the draft says it is inside the policy');
  return { rid, page: draft, picks };
}

async function confirmWithin(w, rid, page, who = w.people.employee.b) {
  let res = await who.post(`${w.B}/trips/${rid}/submit`, formOf(page.text, `${w.B}/trips/${rid}/submit`));
  assert.equal(res.status, 303);
  assert.match(res.location || '', /\?ok=auto_approved$/, `Confirm trip answers auto_approved (${res.location})`);
  res = await who.follow(res);
  const main = pageChecks('approved by policy', res);
  assert.match(textOf(main), /Approved to book\./, '"Approved to book"');
  assert.match(textOf(main), /Nothing has been booked or charged\./, 'nothing booked or charged');
  return res;
}

async function employeeWithin(w) {
  const sam = w.people.employee.b;
  let res = await sam.get(w.B);
  pageChecks('employee home', res);
  assert.match(textOf(res.text), /Plan a trip/, 'the employee home offers Plan a trip');
  res = await sam.get(`${w.B}/trips/new`);
  const main = pageChecks('/trips/new', res);
  assert.match(textOf(main), /Your department: Engineering · Your policy: Standard/, 'the trip form names the department and policy');
  res = await search(w, sam, Q);
  const m = pageChecks('/trips/search economy', res);
  assert.match(m, /class="bz-limits"/, 'the limits bar');
  assert.match(textOf(m), /Within Policy/, 'Within Policy badges');
  assert.match(textOf(m), /Price to Beat/, 'the Price to Beat');
  assert.ok(/Demo price/.test(textOf(m)) && /Priced at/.test(textOf(m)), 'Demo price · Priced at');
  const { rid, res: draft } = await reviewTrip(w, sam, res.text, withinPicks(res.text), 'Client workshop in London');
  assert.match(textOf(pageChecks('draft within', draft)), /Every part of this trip is inside your policy/);
  await confirmWithin(w, rid, draft);
  w.rids.within = rid;
  return rid;
}

/** An out-of-policy trip (Business class and a 5-star hotel): alternatives, an optional swap, Request Approval. */
async function outTrip(w, purpose, { swap = false, who = w.people.employee.b } = {}) {
  let r = await search(w, who, BQ);
  pageChecks('/trips/search business', r);
  assert.match(textOf(mainOf(r.text)), /Out of Policy/, `${purpose}: Out of Policy badges`);
  const ch = choices(r.text);
  const out = ch.find(c => c.name === 'out' && c.state === 'out');
  const back = ch.find(c => c.name === 'back' && c.state === 'out');
  const h5 = ch.find(c => c.name === 'hotelKey' && /5-star/.test(c.card) && (c.state === 'out' || c.state === 'within'));
  assert.ok(out && back && h5, `${purpose}: business-class flights and a 5-star hotel to pick`);
  const made = await reviewTrip(w, who, r.text, { out: out.value, back: back.value, hotelKey: h5.value }, purpose);
  const rid = made.rid;
  r = made.res;
  let body = textOf(pageChecks(`${purpose} draft`, r));
  assert.match(body, /Out of policy: \d+ reasons?/, `${purpose}: says out of policy with reasons`);
  const altsAt = body.indexOf('AI-powered cheaper alternatives');
  assert.ok(altsAt > 0 && body.indexOf('Request Approval') > altsAt, `${purpose}: AI-powered cheaper alternatives come before Request Approval`);
  assert.match(body, /Goes to Dana Lee \(your manager\)\./, `${purpose}: names the manager`);
  if (swap) {
    const alt = formsOf(r.text, `${w.B}/trips/${rid}/swap`)[0];
    assert.ok(alt, `${purpose}: a "Use this option" form`);
    r = await who.post(`${w.B}/trips/${rid}/swap`, fieldsOf(alt));
    assert.equal(r.status, 303, `${purpose}: the swap: ${short(textOf(mainOf(r.text)))}`);
    assert.match(r.location || '', /\?ok=swapped$/);
    r = await who.follow(r);
    body = textOf(pageChecks(`${purpose} swapped`, r));
    assert.match(body, /Switched to the cheaper option/, `${purpose}: the swap notice`);
    assert.match(body, /Saved \$[\d,]+ by switching/, `${purpose}: the saving shows`);
  }
  let fp = formOf(r.text, `${w.B}/trips/${rid}/submit`);
  const stillOut = /Out of policy/.test(textOf(mainOf(r.text)));
  if (stillOut) {
    // A reason under the company's minimum is refused (422) and nothing is sent.
    const shortReason = await who.post(`${w.B}/trips/${rid}/submit`, setFields(fp, { reason: 'Need it', category: 'client_meeting' }));
    assert.equal(shortReason.status, 422, `${purpose}: a 7-character reason is refused`);
    fp = setFields(fp, { reason: REASON, category: 'client_meeting' });
  }
  r = await who.post(`${w.B}/trips/${rid}/submit`, fp);
  assert.equal(r.status, 303, `${purpose}: Request Approval: ${short(textOf(mainOf(r.text)))}`);
  assert.match(r.location || '', stillOut ? /\?ok=submitted$/ : /\?ok=(submitted|auto_approved)$/);
  r = await who.follow(r);
  if (stillOut) {
    assert.match(textOf(pageChecks(`${purpose} pending`, r)), /Sent for approval\. We don't send emails yet, so Dana Lee will see it under Approvals\./, `${purpose}: sent to Dana`);
  }
  return { rid, page: r, picks: { out: out.value, back: back.value, hotelKey: h5.value } };
}

async function employeeOut(w) {
  w.rids.approve = (await outTrip(w, 'Board meeting in London', { swap: true })).rid;
  w.rids.deny = (await outTrip(w, 'Partner summit in London')).rid;
  w.rids.ask = (await outTrip(w, 'Sales conference in London')).rid;
}

// A3 6: the Manager: inbox, then the request with the fresh price check, budget impact and the cheapest
// option inside policy. Approve one, deny one with a reason, ask a question on a third.

async function managerView(w, rid, label) {
  const r = await w.people.manager.b.get(`${w.B}/trips/${rid}`);
  assert.equal(r.status, 200);
  const body = textOf(pageChecks(`request ${label}`, r));
  assert.match(body, /Price check|checked again|Rechecked/i, `${label}: the fresh price check`);
  assert.ok(/Budget/i.test(body) && /Engineering/.test(body), `${label}: the budget impact`);
  assert.match(body, /Cheapest option inside your policy|Cheapest inside policy|cheapest option inside/i, `${label}: the cheapest option inside policy`);
  assert.ok(body.includes(REASON.slice(0, 40)), `${label}: the reason`);
  return r;
}

async function decide(w, rid, action, note) {
  const dana = w.people.manager.b;
  const page = await managerView(w, rid, action);
  let fp = setField(formOf(page.text, `${w.B}/trips/${rid}/decide`), 'action', action);
  if (note) fp = setField(fp, 'note', note);
  const r = await dana.post(`${w.B}/trips/${rid}/decide`, fp);
  assert.equal(r.status, 303, `${action}: ${short(textOf(mainOf(r.text)))}`);
  return pageChecks(`after ${action}`, await dana.follow(r));
}

async function managerDecisions(w) {
  const dana = w.people.manager.b, sam = w.people.employee.b;
  const { approve, deny, ask } = w.rids;
  let res = await dana.get(`${w.B}/approvals`);
  let main = pageChecks('/approvals', res);
  for (const rid of [approve, deny, ask]) assert.ok(main.includes(`href="${w.B}/trips/${rid}"`), `the inbox links to ${rid}`);
  assert.ok((textOf(main).match(/Sam Rivera/g) || []).length >= 3, 'the inbox shows Sam three times');
  assert.match(textOf(main), /Waiting for you 3 /, 'Waiting for you 3');
  assert.ok(/Approvals/.test(textOf(res.text)) && /bz-count|>3</.test(res.text), 'the Approvals item carries a count');
  // Sam cannot approve his own trip: the decide form is not his, and a forged POST is refused.
  const own = await sam.post(`${w.B}/trips/${approve}/decide`, { action: 'approve', rev: '0' });
  assert.ok([403, 404].includes(own.status), `the traveler cannot decide (${own.status})`);

  main = await decide(w, approve, 'approve');
  assert.match(textOf(main), /Approved/, 'approve: the request shows Approved');
  // Deny needs a reason: a short note is refused.
  const page = await managerView(w, deny, 'deny (short note)');
  const refused = await dana.post(`${w.B}/trips/${deny}/decide`, setFields(formOf(page.text, `${w.B}/trips/${deny}/decide`), { action: 'deny', note: 'No.' }));
  assert.equal(refused.status, 422, 'deny with a 3-character note is refused');
  main = await decide(w, deny, 'deny', 'Please take Economy for this one; the summit is a short trip.');
  assert.ok(/Denied/.test(textOf(main)) && /Please take Economy for this one/.test(textOf(main)), 'deny: Denied with the note');

  res = await dana.get(`${w.B}/trips/${ask}`);
  res = await dana.post(`${w.B}/trips/${ask}/message`, setField(formOf(res.text, `${w.B}/trips/${ask}/message`), 'text', 'Could you share the agenda for the conference?'));
  assert.equal(res.status, 303, `ask: ${short(textOf(mainOf(res.text)))}`);
  main = pageChecks('after ask', await dana.follow(res));
  assert.match(textOf(main), /Could you share the agenda/, 'ask: the question shows on the request');
  res = await sam.get(`${w.B}/trips/${ask}`);
  assert.match(textOf(mainOf(res.text)), /Could you share the agenda/, 'ask: the employee sees the question');
  res = await sam.post(`${w.B}/trips/${ask}/message`, setField(formOf(res.text, `${w.B}/trips/${ask}/message`), 'text', 'The agenda is in the shared folder; day one is the client keynote.'));
  assert.equal(res.status, 303, 'the employee answers the question');
  res = await sam.get(`${w.B}/trips`);
  main = pageChecks('/trips (employee)', res);
  assert.ok(/Approved/.test(textOf(main)) && /Denied/.test(textOf(main)) && /Waiting|Pending/.test(textOf(main)), 'the employee trip list shows each status');
  res = await sam.get(`${w.B}/trips/${deny}`);
  assert.match(textOf(mainOf(res.text)), /Please take Economy for this one/, 'the employee sees the deny reason');
}

// A3 7: Finance: Q4 reports (committed vs budget, out-of-policy share, top reasons, saved by switching), then the CSV.

async function financeReports(w) {
  const fay = w.people.finance.b;
  let res = await fay.get(`${w.B}/reports?period=2026-Q4`);
  const rt = textOf(pageChecks('/reports', res));
  assert.ok(/Committed/i.test(rt) && /Budget/i.test(rt), 'committed vs budget');
  assert.ok(/out of policy/i.test(rt) && /%/.test(rt), 'out-of-policy share');
  assert.match(rt, /reason/i, 'top reasons');
  assert.match(rt, /[Ss]aved by switching|switching to cheaper/, 'saved by switching');
  res = await fay.post(`${w.B}/reports/export`, formOf(res.text, `${w.B}/reports/export`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/, 'the CSV answers text/csv');
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="[^"]+\.csv"/, 'as an attachment');
  const lines = res.text.trim().split(/\r?\n/);
  assert.ok(lines.length >= 5, `the CSV has a header and the four trips (${lines.length} lines)`);
  for (const rid of Object.values(w.rids)) assert.ok(res.text.includes(rid), `the CSV has ${rid}`);
  assert.doesNotMatch(res.text, /netCents|supplierQuoteRef|markup|commission/i, 'the CSV holds nothing internal');
  assert.match(lines[0], /^﻿?price_source,/, 'the first column is price_source');
  assert.ok(lines.slice(1).every(l => /^"?Demo price/.test(l)), 'every CSV row starts with Demo price');
}

// A3 8: activity, settings and export, the company switcher (a user in two companies).

async function activitySettings(w) {
  const { owner, B } = w;
  let res = await owner.get(`${B}/activity`);
  const at = textOf(pageChecks('/activity', res));
  for (const what of [/invite/i, /polic/i, /approv/i, /denied|deny/i, /budget/i]) assert.match(at, what, `activity mentions ${what}`);
  res = await owner.get(`${B}/settings`);
  pageChecks('/settings', res);
  assert.ok(res.text.includes(w.names.company.replace(/&/g, '&amp;')) || textOf(res.text).includes(w.names.company), 'settings show the company name');
  res = await owner.post(`${B}/settings`, setField(formOf(res.text, `${B}/settings`), 'outOfPolicy', 'approval'));
  assert.equal(res.status, 303, `saving settings: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\?ok=saved$/);
  res = await owner.follow(res);
  assert.match(textOf(res.text), /Settings saved\./, 'the saved notice');
  res = await owner.post(`${B}/settings/export`, formOf(res.text, `${B}/settings/export`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment/, 'the company export downloads');
  assert.doesNotMatch(res.text, /passwordHash|tokenHash|"token"/, 'the export holds no secrets');
}

/**
 * A second company for the owner, confirmed by the platform admin, and Sam invited to it: his switcher, the
 * chooser and both workspaces. `beforeConfirm(orgId, base)` runs while the second company is still pending.
 */
async function switcher(w, { beforeConfirm = null } = {}) {
  const { owner, names, B } = w;
  const sam = w.people.employee.b;
  let res = await owner.get('/business/start');
  res = await owner.post('/business/start', setFields(formOf(res.text, '/business/start'), { companyName: names.second, size: '1-10 people', timezone: 'Africa/Cairo', ack: '1' }));
  assert.equal(res.status, 303, `the owner creates a second company: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\/welcome$/);
  const org2 = res.location.split('/')[3];
  const B2 = `/business/o/${org2}`;
  w.B2 = B2;
  if (beforeConfirm) await beforeConfirm(org2, B2);
  await confirmCompany(w, org2, names.second);
  res = await owner.get(`${B2}/people`);
  const ib = formsOf(res.text, `${B2}/people/invite`)[0];
  res = await owner.post(`${B2}/people/invite`, setFields(fieldsOf(ib || ''), { email: names.email('sam'), role: 'employee' }));
  assert.equal(res.status, 200, 'the owner invites Sam to the second company');
  const t2 = (/\/business\/invite\/([A-Za-z0-9_-]{16,})/.exec(res.text) || [])[1];
  res = await sam.get(`/business/invite/${t2}`);
  assert.equal(res.status, 200);
  assert.equal(formsOf(res.text, `/business/invite/${t2}/accept`).length, 1, 'signed in, Sam sees the accept form');
  res = await sam.post(`/business/invite/${t2}/accept`, formOf(res.text, `/business/invite/${t2}/accept`));
  assert.equal(res.status, 303);
  assert.equal(res.location, B2, 'accept answers 303 to the second company');
  res = await sam.get(B);
  const sw = (res.text.match(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/) || [''])[0];
  assert.ok(textOf(sw).includes(names.company) && textOf(sw).includes(names.second), "Sam's switcher shows both companies");
  assert.match(sw, new RegExp(`href="${escRe(B2)}"`), 'the switcher links to the second company');
  res = await sam.get('/business/app');
  assert.equal(res.status, 200);
  assert.ok(textOf(res.text).includes(names.second) && textOf(res.text).includes(names.company), '/business/app lists both');
  res = await sam.get(B2);
  assert.equal(res.status, 200);
  assert.ok(textOf(res.text).includes(names.second), 'Sam opens the second company');
  const sw2 = (res.text.match(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/) || [''])[0];
  assert.match(sw2, new RegExp(`href="${escRe(B)}"`), 'and can switch back');
  // Isolation: the first company's trips are not reachable or listed from the second.
  assert.equal((await sam.get(`${B2}/trips/${w.rids.within}`)).status, 404, 'a first-company trip under the second company URL is 404');
  res = await sam.get(`${B2}/trips`);
  assert.ok(!textOf(mainOf(res.text)).includes('Client workshop in London'), 'the second company lists none of the first company trips');
  // Dana is in one company only: no second company in her switcher, and the second company is a 404 for her.
  assert.equal((await w.people.manager.b.get(B2)).status, 404, 'a member of the first company only gets 404 in the second');
}

async function roleMenus(w) {
  const { B, owner } = w;
  const roleBrowsers = { owner, travelAdmin: w.people.travelAdmin.b, manager: w.people.manager.b, finance: w.people.finance.b, employee: w.people.employee.b };
  const seen = {};
  for (const [role, who] of Object.entries(roleBrowsers)) {
    const home = await who.get(B);
    assert.equal(home.status, 200, `${role}: home`);
    const nav = (home.text.match(/<nav\b[^>]*class="[^"]*bz-nav[^"]*"[\s\S]*?<\/nav>/) || home.text.match(/<nav\b[\s\S]*?<\/nav>/) || [''])[0];
    const hrefs = [...new Set([...nav.matchAll(/href="([^"#]+)"/g)].map(m => decode(m[1])).filter(h => h.startsWith(B)))];
    assert.ok(hrefs.length >= 4, `${role}: the menu has links (${hrefs.join(' ')})`);
    for (const h of hrefs) {
      const r = await who.get(h);
      assert.equal(r.status, 200, `${role}: ${h.replace(B, '') || '/'}: ${short(textOf(mainOf(r.text)))}`);
      pageChecks(`${role} ${h.replace(B, '') || '/'}`, r);
    }
    seen[role] = hrefs.map(h => h.replace(B, '') || '/');
  }
  // Each role's menu offers what §D gives it: only deciders see Approvals, only finance roles see Reports.
  assert.ok(seen.manager.includes('/approvals') && !seen.employee.includes('/approvals') && !seen.finance.includes('/approvals'), 'Approvals for deciders only');
  assert.ok(seen.finance.includes('/reports') && !seen.employee.includes('/reports') && !seen.manager.includes('/reports'), 'Reports for finance roles');
  assert.ok(!seen.employee.includes('/people') && !seen.employee.includes('/budgets'), 'no People or Budgets for an employee');
  return seen;
}

// A3 10: every amount reads "Demo price · Priced at …"; nothing is booked or charged; no email is sent.

async function demoHonesty(w) {
  const { B, owner } = w;
  const sam = w.people.employee.b, dana = w.people.manager.b, fay = w.people.finance.b;
  for (const [who, path] of [[sam, `${B}/trips/${w.rids.within}`], [dana, `${B}/approvals`], [fay, `${B}/reports?period=2026-Q4`], [owner, `${B}/budgets?period=2026-Q4`], [owner, `${B}/activity`], [sam, `${B}/policy`], [sam, `${B}/trips`]]) {
    const r = await who.get(path);
    assert.equal(r.status, 200, path);
    const m = mainOf(r.text);
    const amounts = (textOf(m).match(/\$\d[\d,]*/g) || []).length;
    if (amounts) assert.ok(/data-price-source="demo"/.test(m) && /Demo price/.test(textOf(m)), `${path}: its ${amounts} amounts are labelled Demo price`);
    assert.match(textOf(r.text), /Nothing is booked or charged/, `${path}: the demo ribbon`);
  }
}

async function signOut(w) {
  const sam = w.people.employee.b;
  const res = await sam.post('/business/signout', formOf((await sam.get(w.B)).text, '/business/signout'));
  assert.equal(res.status, 303, 'sign out');
  const after = await sam.get(w.B);
  assert.equal(after.status, 303);
  assert.match(after.location || '', /\/business\/signin/, 'signed out, the workspace sends to sign in');
}

/** Sign a member back in through /business/signin, in the same browser. */
async function signIn(w, key) {
  const who = w.people[key];
  let res = await who.b.get('/business/signin');
  res = await who.b.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email: who.email, password: PASSWORD }));
  assert.equal(res.status, 303, `${key} signs in again: ${short(textOf(mainOf(res.text)))}`);
  assert.equal((await who.b.get(w.B)).status, 200);
}

/** The whole §A3 walk (items 1 to 8 and 10), in order, on one company. */
async function a3Walk(w, step = async (name, fn) => fn()) {
  await step('1. home, /business, sign up as Owner of a pending company', () => signUpOwner(w));
  await step('2. the platform admin confirms the company', () => platformConfirm(w));
  await step('3. policies (v2 in history), departments, Q4 budgets', () => policiesDepartmentsBudgets(w));
  await step('4. four invites, each accepted in a fresh browser that creates its account', () => invites(w));
  await step('5a. employee: a trip inside policy is approved to book', () => employeeWithin(w));
  await step('5b. employee: out of policy, alternatives, a swap, Request Approval', () => employeeOut(w));
  await step('6. manager: approve, deny with a reason, ask a question', () => managerDecisions(w));
  await step('7. finance: Q4 reports and the CSV', () => financeReports(w));
  await step('8a. activity, settings and the company export', () => activitySettings(w));
  await step('8b. the company switcher for a member of two companies', () => switcher(w));
  await step('8c. every role opens every page its menu offers', () => roleMenus(w));
  await step('10. every amount is a demo price; nothing booked or charged', () => demoHonesty(w));
  await step('sign out', () => signOut(w));
  return w;
}

// ---------------------------------------------------------------------------------------------------------
// Scenarios beyond the walk

/** The store methods that can change what a store holds (MemoryStore and PostgresStore alike). */
const WRITE_METHODS = Object.freeze([
  'putRecord', 'insertRecord', 'updateRecord', 'deleteRecord', 'commit', 'saveQuote', 'createBooking', 'updateBooking', 'savePaymentIntent', 'savePartnerLead',
]);

/**
 * Record every store write from now on, on any store: stop() puts the methods back and returns the names called.
 * @param {object} app
 * @returns {{ stop: () => string[] }}
 */
function watchWrites(app) {
  const s = app.store;
  const seen = [], undo = [];
  for (const name of WRITE_METHODS) {
    if (typeof s[name] !== 'function') continue;
    const own = Object.prototype.hasOwnProperty.call(s, name);
    const real = s[name];
    s[name] = function counted(...args) { seen.push(name); return real.apply(this, args); };
    undo.push(() => { if (own) s[name] = real; else delete s[name]; });
  }
  return { stop() { for (const f of undo) f(); return seen; } };
}

/**
 * Expiry via the clock: a request left pending past its approval window shows as expired with no write, and a
 * decision on it is refused with 409 and persists the expiry.
 */
async function expiryFlow(w) {
  const svc = w.app.business;
  const sam = w.people.employee.b, dana = w.people.manager.b;
  const { rid } = await outTrip(w, 'Expiry check in London');
  const stored = await w.app.store.getRecord('biz_request', rid);
  assert.equal(stored.status, 'pending');
  assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.submittedAt), 24 * 3600000, 'the company approval window is 24 hours');
  let inbox = await dana.get(`${w.B}/approvals`);
  assert.ok(mainOf(inbox.text).includes(`href="${w.B}/trips/${rid}"`), 'waiting in the inbox');

  // One hour past the window.
  w.clock.set(new Date(Date.parse(stored.expiresAt) + 3600000).toISOString());
  const before = w.app.store.kind === 'memory' ? storeSnapshot(w.app) : null;
  const writes = watchWrites(w.app);
  let res = await sam.get(`${w.B}/trips/${rid}`);
  assert.equal(res.status, 200);
  let body = textOf(pageChecks('expired (traveler)', res));
  assert.match(body, /Expired at .*\. Nothing was approved\./, 'the traveler sees it expired');
  res = await dana.get(`${w.B}/trips/${rid}`);
  assert.equal(res.status, 200);
  body = textOf(pageChecks('expired (manager)', res));
  assert.match(body, /Expired/, 'the manager sees it expired');
  assert.equal(formsOf(res.text, `${w.B}/trips/${rid}/decide`).length, 0, 'no decide form on an expired request');
  inbox = await dana.get(`${w.B}/approvals`);
  assert.ok(!mainOf(inbox.text).includes(`href="${w.B}/trips/${rid}"`), 'no longer waiting in the inbox');
  inbox = await dana.get(`${w.B}/approvals?tab=expired`);
  assert.equal(inbox.status, 200);
  assert.ok(mainOf(inbox.text).includes(`href="${w.B}/trips/${rid}"`), 'listed under Expired');
  res = await sam.get(`${w.B}/trips`);
  assert.match(textOf(mainOf(res.text)), /Expired/, 'the trip list says Expired');
  assert.deepEqual(writes.stop(), [], 'reading an expired request writes nothing');
  if (before !== null) assert.equal(storeSnapshot(w.app), before, 'and the memory store holds exactly what it held');
  assert.equal((await w.app.store.getRecord('biz_request', rid)).status, 'pending', 'still stored as pending');

  // A decision now: 409, the page says when it expired, and the expiry is persisted (audit by the clock).
  res = await dana.post(`${w.B}/trips/${rid}/decide`, { action: 'approve', rev: String(stored.rev) });
  assert.equal(res.status, 409, `deciding an expired request: ${short(textOf(mainOf(res.text)))}`);
  assert.match(textOf(mainOf(res.text)), /This request expired at/, 'the refusal says it expired');
  const after = await w.app.store.getRecord('biz_request', rid);
  assert.equal(after.status, 'expired', 'the POST persisted the expiry');
  const audit = await svc.listAudit(await memberActor(w, 'moataz'), {});
  assert.ok(audit.rows.some(e => e.action === 'request.expired' && e.target.id === rid && e.actor && e.actor.system === 'clock'), 'audited as the clock');
  // The traveler can no longer cancel or send it: terminal.
  res = await sam.post(`${w.B}/trips/${rid}/cancel`, { rev: String(after.rev) });
  assert.equal(res.status, 409, 'an expired request cannot be cancelled');
  w.rids.expired = rid;
  return rid;
}

/**
 * Swap the live inventory for the real seam's override (createBusinessInventory with overrides wrapping the
 * same providers), so a test can move one option's price. Returns the wrapped providers and a restore().
 */
function overrideInventory(w) {
  const svc = w.app.business;
  const was = svc.inventory;
  const flights = overrideProvider(was.flights), hotels = overrideProvider(was.hotels);
  const inv = createBusinessInventory(w.app.config, { overrides: { flights, hotels } });
  assert.equal(inv.status, 'demo');
  svc.inventory = inv;
  svc.composer.inventory = inv;
  return { flights, hotels, restore() { svc.inventory = was; svc.composer.inventory = was; } };
}

/** The account behind a demo email (by its local part), as the store keeps it. */
async function userOf(w, local) {
  const link = await w.app.store.getRecord('user_email', w.names.email(local));
  assert.ok(link, `an account for ${local}`);
  return w.app.store.getRecord('user', link.userId);
}

/** A MemberActor in the first company, for reading through the service. */
const memberActor = async (w, local) => ({ org: { id: w.orgId }, user: await userOf(w, local) });

const totalOf = async (w, rid) => (await w.app.store.getRecord('biz_request', rid)).totalCents;

/**
 * A price change returns a trip: the hotel option of a draft prices $29 more when it is sent, so Request
 * Approval (here Confirm trip) sends it back to the traveler with was and now; sent again it goes through at
 * the new price. Then a pending request's hotel moves while it waits: the manager's fresh check shows it, and
 * approving sends it back to the traveler with nothing approved.
 */
async function priceChangeFlow(w) {
  const sam = w.people.employee.b, dana = w.people.manager.b;
  const ov = overrideInventory(w);
  try {
    // 1. Before it is sent.
    const { rid, page, picks } = await withinDraft(w, 'Price check workshop in London');
    const was = await totalOf(w, rid);
    const hotel = rowKeyParts(picks.hotelKey);
    ov.hotels.setPrice(hotel.offerId, hotel.optionId, 2900);
    let res = await sam.post(`${w.B}/trips/${rid}/submit`, formOf(page.text, `${w.B}/trips/${rid}/submit`));
    assert.equal(res.status, 303);
    assert.match(res.location || '', /\?ok=repriced$/, 'the trip went back to the traveler');
    res = await sam.follow(res);
    let body = textOf(pageChecks('repriced', res));
    assert.match(body, /This trip changed before it was sent\. Review it and send it again\./);
    assert.match(body, /The price changed\./);
    assert.match(body, /Was \$[\d,.]+ ?, now \$[\d,.]+ ?\./, 'was and now');
    let stored = await w.app.store.getRecord('biz_request', rid);
    assert.equal(stored.status, 'draft');
    assert.equal(stored.returned.why, 'price_changed');
    assert.deepEqual([stored.returned.fromCents, stored.returned.toCents], [was, was + 2900]);
    assert.equal(stored.totalCents, was + 2900, 'the draft carries the new total');
    // Sent again at the new price: approved by policy, holding the new total.
    res = await sam.post(`${w.B}/trips/${rid}/submit`, formOf(res.text, `${w.B}/trips/${rid}/submit`));
    assert.match(res.location || '', /\?ok=auto_approved$/, `sent again (${res.location})`);
    stored = await w.app.store.getRecord('biz_request', rid);
    assert.deepEqual([stored.status, stored.budget.cents], ['approved', was + 2900]);
    w.rids.repriced = rid;

    // 2. While it waits for the manager.
    const pending = await outTrip(w, 'Price check summit in London');
    const before = await totalOf(w, pending.rid);
    const h5 = rowKeyParts(pending.picks.hotelKey);
    res = await dana.get(`${w.B}/trips/${pending.rid}`);
    assert.match(textOf(pageChecks('manager live check (same)', res)), /Price checked again at [^:]+:\d\d [AP]M today: unchanged\./, 'the fresh check: unchanged');
    ov.hotels.setPrice(h5.offerId, h5.optionId, 2900);
    res = await dana.get(`${w.B}/trips/${pending.rid}`);
    body = textOf(pageChecks('manager live check (changed)', res));
    assert.match(body, /Price checked again at [^:]+:\d\d [AP]M today: now \$[\d,.]+ ?\(was \$[\d,.]+ ?\)\. If you approve, it goes back to Sam to confirm the new price\./, 'the fresh check shows the new price');
    res = await dana.post(`${w.B}/trips/${pending.rid}/decide`, setField(formOf(res.text, `${w.B}/trips/${pending.rid}/decide`), 'action', 'approve'));
    assert.equal(res.status, 303, `approve on a changed price: ${short(textOf(mainOf(res.text)))}`);
    assert.match(res.location || '', /\?ok=returned$/);
    assert.match(textOf(pageChecks('returned (manager)', await dana.follow(res))), /The price changed while this was waiting, so it went back to Sam\. Nothing was approved\./);
    stored = await w.app.store.getRecord('biz_request', pending.rid);
    assert.equal(stored.status, 'draft', 'nothing approved: back to the traveler');
    assert.equal(stored.returned.why, 'price_changed');
    assert.deepEqual([stored.returned.fromCents, stored.returned.toCents], [before, before + 2900]);
    assert.equal(stored.approval, null, 'the approval is cleared');
    res = await sam.get(`${w.B}/trips/${pending.rid}`);
    assert.match(textOf(pageChecks('returned to the traveler', res)), /The price changed while this was waiting, so it came back to you\. Nothing was approved\./);
    w.rids.returned = pending.rid;
  } finally {
    ov.restore();
  }
}

/** Budget committed for a department in a period, as Finance reads it through the service. */
async function committed(w, dept = 'Engineering', period = '2026-Q4') {
  const rows = await w.app.business.listBudgets(await memberActor(w, 'fay'), period);
  return rows.find(r => r.department.id === w.deptIds[dept]);
}

/** Cancel releases the budget hold: an approved trip's cancel (two steps) gives its amount back to the budget. */
async function cancelFlow(w) {
  const sam = w.people.employee.b;
  const start = await committed(w);
  const { rid, page } = await withinDraft(w, 'Cancel check workshop in London');
  await confirmWithin(w, rid, page);
  const hold = (await w.app.store.getRecord('biz_request', rid)).budget.cents;
  let row = await committed(w);
  assert.equal(row.committedCents, start.committedCents + hold, 'the approved trip holds its total');
  let res = await w.owner.get(`${w.B}/budgets?period=2026-Q4`);
  pageChecks('/budgets with the hold', res);

  // Two steps: the link, then "Yes, cancel this trip".
  res = await sam.get(`${w.B}/trips/${rid}`);
  assert.equal(formsOf(res.text, `${w.B}/trips/${rid}/cancel`).length, 0, 'no one-tap cancel on an approved trip');
  assert.match(res.text, new RegExp(`href="${escRe(`${w.B}/trips/${rid}`)}\\?confirm=cancel#cancel"`), 'a link to the confirm step');
  res = await sam.get(`${w.B}/trips/${rid}?confirm=cancel`);
  assert.match(textOf(mainOf(res.text)), /Cancel this trip\?/);
  res = await sam.post(`${w.B}/trips/${rid}/cancel`, formOf(res.text, `${w.B}/trips/${rid}/cancel`));
  assert.equal(res.status, 303, `cancel: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\?ok=cancelled$/);
  res = await sam.follow(res);
  assert.match(textOf(pageChecks('cancelled', res)), /Nothing was booked or charged\./);
  const stored = await w.app.store.getRecord('biz_request', rid);
  assert.equal(stored.status, 'cancelled');
  row = await committed(w);
  assert.equal(row.committedCents, start.committedCents, 'the hold is released');
  const budget = await w.app.store.getRecord('biz_budget', `${w.orgId}.${w.deptIds.Engineering}.2026-Q4`);
  assert.ok(!Object.hasOwn(budget.commits, rid), 'no commit left for the cancelled trip');
  w.rids.cancelled = rid;
  return rid;
}

/**
 * A3 8, production: APP_ENV=production with no supplier. Sign-up works, the company waits for Tripelyx, and
 * every trip page says "Supplier not connected yet." with no prices and no demo talk.
 */
async function productionFlow(p) {
  assert.equal(p.app.config.isProduction, true);
  assert.equal(p.app.config.trips.enabled, false, 'trips off');
  assert.equal(p.app.business.inventory.status, 'none', 'production business inventory is "none"');
  const b = browser(p.base, { 'x-forwarded-proto': 'https' });
  let res = await b.get('/business/start');
  assert.equal(res.status, 200, 'production /business/start');
  res = await b.post('/business/start', setFields(formOf(res.text, '/business/start'), {
    name: 'Moataz Owner', email: p.names.email('moataz.prod'), password: PASSWORD, companyName: p.names.prodCompany, size: '11-50 people', timezone: 'Africa/Cairo', ack: '1',
  }));
  assert.equal(res.status, 303, `production sign-up: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /^\/business\/o\/[^/]+\/welcome$/);
  const B = `/business/o/${res.location.split('/')[3]}`;
  res = await b.follow(res);
  assert.equal(res.status, 200, 'the welcome page');
  res = await b.get(`${B}/trips/new`);
  assert.equal(res.status, 200, 'production /trips/new');
  const main = pageChecks('/trips/new (production)', res, { demo: false });
  assert.ok(textOf(main).includes('Supplier not connected yet.'), '"Supplier not connected yet."');
  assert.match(main, /<fieldset class="bz-search-fields"[^>]*disabled/, 'the search fields are disabled');
  assert.doesNotMatch(textOf(main), /demo/i, 'no demo flights talked about');
  res = await b.get(`${B}/trips/search?${new URLSearchParams(Q)}`);
  assert.equal(res.status, 503, 'production search answers 503');
  assert.match(textOf(mainOf(res.text)), /Supplier not connected yet\./, 'with the same words');
  assert.doesNotMatch(res.text, /bz-money|Demo price/, 'no prices on the production search');
  const snap = storeSnapshot(p.app);
  res = await b.post(`${B}/trips`, { ...Q, out: 'f.flt_x|LIGHT', purpose: 'A trip with no supplier' });
  assert.equal(res.status, 503, 'Review trip answers 503 with no supplier');
  assert.equal(storeSnapshot(p.app), snap, 'and writes nothing');
  res = await b.get(B);
  assert.equal(res.status, 200);
  assert.match(textOf(mainOf(res.text)), /Supplier not connected yet\./, 'the production home says so too');
  assert.ok(textOf(res.text).includes(`Tripelyx is confirming ${p.names.prodCompany}`), 'the production company is pending');
  assert.doesNotMatch(textOf(res.text), /Preview: flights, hotels and prices are demo data/, 'no demo ribbon in production');
  res = await b.get(`${B}/policy`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(textOf(mainOf(res.text)), /demo/i, 'the production policy page names no demo fares');
  // Everything a company sets up still works with no supplier: a department and the policies.
  res = await b.get(`${B}/people`);
  const form = formsOf(res.text, `${B}/departments`).find(f => !/name="departmentId"/.test(f));
  res = await b.post(`${B}/departments`, setField(fieldsOf(form || ''), 'name', 'Sales'));
  assert.equal(res.status, 303, 'a department is added in production');
  assert.equal((await b.get(`${B}/policies/standard`)).status, 200, 'the policy editor opens in production');
}

module.exports = {
  PASSWORD, Q, BQ, REASON, PRESSURE,
  textOf, mainOf, formsOf, fieldsOf, formOf, setField, setFields, getField, pageChecks, privateHeaders, browser, choices, rowKeyParts,
  namesFor, devWorld, prodWorld,
  signUpOwner, platformAdmin, confirmCompany, platformConfirm, policiesDepartmentsBudgets, inviteAndJoin, invites, company,
  search, reviewTrip, withinDraft, confirmWithin, employeeWithin, outTrip, employeeOut, managerDecisions, financeReports,
  activitySettings, switcher, roleMenus, demoHonesty, signOut, signIn, a3Walk,
  expiryFlow, overrideInventory, priceChangeFlow, committed, cancelFlow, productionFlow, watchWrites,
};
