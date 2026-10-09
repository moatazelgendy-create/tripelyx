#!/usr/bin/env node
// Tripelyx Business demo (plan §L Stage 3 step 3): fictional demo companies on the in-memory store, for
// clicking through Business locally or on the private preview. Used two ways:
//
// 1. As a command, on your own computer (development only):
//      APP_ENV=development node scripts/business-demo.js [--port 4400] [--production-preview 4401]
//    It refuses to run unless APP_ENV=development and the store is the in-memory one (no DATABASE_URL, or
//    DATABASE_URL=memory). It starts the app in this process with Tripelyx Business on, seeds the demo
//    companies, and prints who to sign in as. --production-preview <port> also starts the production config
//    (APP_ENV=production, no supplier: "Supplier not connected yet", an in-memory store, trips off) on a second
//    port, with HTTPS_ONLY forced off so it opens over plain http on your computer only. Nothing is seeded
//    there: sign up a company to see it. Every demo account's password is preview-only-password.
//
// 2. As a module: `await require('./scripts/business-demo').seed(deps)`, which the private preview's boot hook
//    (PREVIEW_SEED=business) calls with createApp's result plus { config, log, now }. seed() refuses itself
//    (it throws) on any store but the in-memory one, and when APP_ENV is production. Its demo accounts use
//    the preview's own password, so one password opens the gate and every demo account: config.preview.password
//    when the config carries it, else PREVIEW_PASSWORD from the environment, used only when its SHA-256 matches
//    the gate's config.preview.gate.passwordDigest (the config keeps only that digest). With neither, they use
//    preview-only-password. The password is never logged; the log names every demo account and its roles, and
//    each test scenario with its page, so whoever reads the boot log knows who to sign in as.
//
// What it seeds, through the BusinessService (the same methods the pages call), on the app's own clock:
// - a platform admin (the first ADMIN_EMAILS address, given a platform_admin record with grantPlatformAdmin);
// - "Demo Company (preview)", confirmed: an Owner, a Travel Admin, Finance, two Managers and four Employees;
//   Sales and Engineering with budgets for this quarter (and the trips' quarter, when that is a later one);
//   the Standard policy plus a Cairo to London route exception and the blocked demo airline ZS (Sahara Wings)
//   (each only when the inventory lists those airports and that airline);
// - only when Business prices come from demo data (inventory.source 'demo'), trip requests in every state: approved by policy, waiting for approval, approved by a manager, denied,
//   cancelled, waiting with a question from the manager, a draft with cheaper alternatives, and two test
//   scenarios, captioned "Test scenario" at the start of their purpose (on each one's request page, in the log
//   and in the command's output; the trip lists show route, dates and status, not the purpose): one that
//   expired (made under a clock set two days back) and one sent back because its hotel price changed (the
//   hotel provider is wrapped so that one room on those dates prices $29 more, and the log says so); after
//   the expired one is made, approvers get 7 days (Settings), so the waiting requests stay waiting for a week
//   after the preview starts. With any other source (the suppliers' test systems on the preview, or no
//   supplier) it makes no trips, so it never calls a supplier, and the log says why;
// - "Second Demo Company (preview)", which shares one employee, so the company switcher has two companies.
// Every name is fictional, every address is on the reserved .example domain, and every trip it makes is priced
// from demo data.
'use strict';

const crypto = require('node:crypto');
const { BusinessService } = require('../server/business/service');
const { Repo } = require('../server/business/repo');
const { TripComposer } = require('../server/business/search');
const { periodKey, currentPeriodKey } = require('../server/business/budgets');
const tz = require('../server/business/tz');
const { LABELS: ROLE_LABELS } = require('../server/business/roles');

/** The demo accounts' password when no preview password is configured (printed by the command only). */
const DEMO_PASSWORD = 'preview-only-password';
const DEMO_COMPANY = 'Demo Company (preview)';
const SECOND_COMPANY = 'Second Demo Company (preview)';
/** The caption on the seeded scenarios, at the start of their purpose. */
const TEST_SCENARIO = 'Test scenario';
/** The command's platform admin address when ADMIN_EMAILS is not set. */
const DEMO_ADMIN_EMAIL = 'platform.admin@tripelyx-demo.example';
/** How much the price-change scenario's hotel room moves on its re-check. */
const PRICE_STEP_CENTS = 2900;
const DAY_MS = 86400000;

const DOMAIN = 'demo-company.example';
const SECOND_DOMAIN = 'second-demo-company.example';
/** The people of Demo Company (preview): fictional names that say their role. */
const PEOPLE = Object.freeze([
  { key: 'owner', name: 'Olivia Owner', email: `owner@${DOMAIN}`, role: 'owner' },
  { key: 'travelAdmin', name: 'Tara Traveladmin', email: `travel.admin@${DOMAIN}`, role: 'travel_admin' },
  { key: 'finance', name: 'Fay Finance', email: `finance@${DOMAIN}`, role: 'finance' },
  { key: 'salesManager', name: 'Mona Manager', email: `sales.manager@${DOMAIN}`, role: 'manager', department: 'Sales' },
  { key: 'engManager', name: 'Milo Manager', email: `engineering.manager@${DOMAIN}`, role: 'manager', department: 'Engineering' },
  { key: 'eli', name: 'Eli Employee', email: `eli.employee@${DOMAIN}`, role: 'employee', department: 'Sales', manager: 'salesManager' },
  { key: 'emma', name: 'Emma Employee', email: `emma.employee@${DOMAIN}`, role: 'employee', department: 'Sales', manager: 'salesManager' },
  { key: 'ezra', name: 'Ezra Employee', email: `ezra.employee@${DOMAIN}`, role: 'employee', department: 'Engineering', manager: 'engManager' },
  { key: 'esme', name: 'Esme Employee', email: `esme.employee@${DOMAIN}`, role: 'employee', department: 'Engineering', manager: 'engManager' },
]);
const SECOND_OWNER = Object.freeze({ key: 'secondOwner', name: 'Owen Owner', email: `owner@${SECOND_DOMAIN}`, role: 'owner' });
/** The employee who is in both companies (the switcher). */
const SHARED = 'eli';
const BUDGETS = Object.freeze({ Sales: '15000', Engineering: '30000' });
const REASON = 'The client meeting is on the first morning, and this is the only flight that lands the evening before.';

/** Why no trips were seeded, per price source: the seed makes trips from demo prices only. */
const NO_TRIPS = Object.freeze({
  sandbox: "No trip requests were seeded: trip prices here come from the suppliers' test systems, and the seed never calls a supplier.",
  live: 'No trip requests were seeded: trip prices here come from the suppliers, and the seed never calls a supplier.',
  none: 'No trip requests were seeded: no supplier is connected, so there are no trip prices.',
});

/** One line for the log (info when the logger has it). */
function say(log, message) {
  const fn = log && (log.info || log.log || log.warn);
  if (typeof fn === 'function') fn.call(log, message);
}

/**
 * The password every demo account gets: the preview's own when configured, else DEMO_PASSWORD. The preview's
 * config keeps only the gate's SHA-256 digest, so PREVIEW_PASSWORD is read from `env` and used only when it
 * matches that digest (the password the gate really asks for, never some other value in the environment).
 * @param {object} config
 * @param {object} [env] default process.env
 * @returns {{ password: string, source: 'preview'|'default' }}
 */
function demoPassword(config, env = process.env) {
  const preview = (config && config.preview) || {};
  const p = preview.password;
  if (typeof p === 'string' && p.length >= 10) return { password: p, source: 'preview' };
  const digest = preview.gate && preview.gate.passwordDigest;
  const fromEnv = env && typeof env.PREVIEW_PASSWORD === 'string' ? env.PREVIEW_PASSWORD : '';
  if (fromEnv.length >= 10 && Buffer.isBuffer(digest) && digest.length === 32) {
    const mine = crypto.createHash('sha256').update(fromEnv, 'utf8').digest();
    if (crypto.timingSafeEqual(mine, digest)) return { password: fromEnv, source: 'preview' };
  }
  return { password: DEMO_PASSWORD, source: 'default' };
}

/** Throws unless this is a Business app on the in-memory store, outside production. */
function assertDemoAllowed({ config, store, business, accounts }) {
  if (!config || config.isProduction || config.appEnv === 'production') throw new Error('The Business demo never runs with APP_ENV=production.');
  if (!store || store.kind !== 'memory') throw new Error('The Business demo only fills the in-memory store (DATABASE_URL=memory).');
  if (!business || !accounts) throw new Error('The Business demo needs Tripelyx Business on (ENABLE_BUSINESS=true).');
}

/**
 * The hotel provider, wrapped so that one room on one stay prices `deltaCents` more on every quote from now
 * on (search rows, the re-check, a new draft): the price-change test scenario. Everything else passes through.
 */
function priceStep(inner, { offerId, optionId, checkIn, checkOut }, deltaCents) {
  const quote = async input => {
    const q = await inner.quote(input);
    const stay = (input && input.query) || {};
    if (!input || input.offerId !== offerId || input.optionId !== optionId || stay.checkIn !== checkIn || stay.checkOut !== checkOut) return q;
    const at = q.lines.findIndex(l => l.kind === 'base');
    if (at < 0) return q;
    return { ...q, lines: q.lines.map((l, i) => (i === at ? { ...l, amount: l.amount + deltaCents } : l)) };
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'quote') return quote;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Seed the demo companies (see the header). Awaited once by the preview's boot hook, or by the command.
 * @param {{ config: object, store: object, accounts: object, business: object, log?: object, now?: () => Date,
 *   env?: object }} deps createApp's result plus config, log and the app clock (now defaults to business.now);
 *   env (default process.env) is where PREVIEW_PASSWORD is read from
 * @returns {Promise<{ companies: { id: string, name: string }[], accounts: { email: string, name: string,
 *   roles: { company: string|null, role: string }[] }[], passwordSource: 'preview'|'default',
 *   requests: { id: string, company: string, traveler: string, purpose: string, status: string }[],
 *   scenarios: { id: string, purpose: string, traveler: string, path: string }[] }>}
 *   who to sign in as, read back from the store (never the password itself)
 * @throws {Error} outside development and staging on the in-memory store, or when a demo account already exists
 */
async function seed(deps = {}) {
  assertDemoAllowed(deps);
  const { config, store, accounts, business: svc, log } = deps;
  const now = typeof deps.now === 'function' ? deps.now : svc.now;
  const { password, source } = demoPassword(config, deps.env || process.env);
  const adminEmail = (config.trips && config.trips.adminEmails || [])[0] || null;
  if (!adminEmail) throw new Error('The Business demo needs ADMIN_EMAILS: its first address becomes the demo platform admin.');
  if (await accounts.emailInUse(PEOPLE[0].email)) throw new Error('The Business demo companies are already here.');

  // Accounts. The platform admin: ADMIN_EMAILS plus a platform_admin record (D1).
  const roster = [];
  const register = async (name, email) => accounts.register({ name, email, password });
  const adminUser = (await accounts.emailInUse(adminEmail))
    ? await store.getRecord('user', (await store.getRecord('user_email', adminEmail)).userId)
    : await register('Pat Platform (demo)', adminEmail);
  await accounts.grantPlatformAdmin(adminUser.id, { by: 'cli', note: 'Business demo seed (scripts/business-demo.js)' });
  const admin = { user: { ...adminUser, isAdmin: await accounts.isPlatformAdmin(adminUser) } };
  if (!admin.user.isAdmin) throw new Error('The demo platform admin could not be granted.');
  roster.push({ email: adminUser.email, name: adminUser.name, roles: [{ company: null, role: 'Platform admin (/admin/business)' }] });

  const users = {};
  for (const p of [...PEOPLE, SECOND_OWNER]) users[p.key] = await register(p.name, p.email);

  // The company, confirmed by the platform admin.
  const confirm = async org => svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev, note: 'Demo company for the preview' });
  const created = await svc.createCompany({ user: users.owner }, { name: DEMO_COMPANY, size: '11-50 people', timezone: 'Africa/Cairo', ack: '1' });
  const org = await confirm(created.org);
  const as = key => ({ org: { id: org.id }, user: users[key] });

  const departments = {};
  for (const name of Object.keys(BUDGETS)) departments[name] = await svc.saveDepartment(as('owner'), { name });

  const join = async (p, orgId, inviter) => {
    const form = { email: p.email, role: p.role };
    if (p.department) form.departmentId = departments[p.department].id;
    if (p.manager) form.managerId = users[p.manager].id;
    const { token } = await svc.invite({ org: { id: orgId }, user: users[inviter] }, form);
    await svc.acceptInvite({ user: users[p.key] }, token);
  };
  for (const p of PEOPLE.slice(1)) await join(p, org.id, 'owner');

  // Where Business prices come from: trips are made from demo prices only, so the seed never calls a supplier.
  const inventory = svc.inventory;
  const priceSource = (inventory && inventory.source) || 'none';
  const seedTrips = priceSource === 'demo';

  // The Standard policy: a Cairo to London route exception (both ways, Premium economy, up to the median of
  // the fares plus 30%) and the demo airline ZS blocked. A new version, with its note. Each part only when the
  // inventory lists its airports or airline (the policy refuses any other), and no new version with neither.
  const route = Boolean(inventory) && ['CAI', 'LHR'].every(code => inventory.airports().some(a => a.code === code));
  const blockZs = Boolean(inventory) && inventory.carriers().some(c => c.code === 'ZS');
  if (route || blockZs) {
    const standard = await svc.getPolicy(as('owner'), 'standard');
    const form = { ...standard.form };
    if (route) {
      Object.assign(form, {
        'route.0.from': 'CAI', 'route.0.to': 'LHR', 'route.0.bothWays': '1',
        'route.0.capMode': 'median_pct', 'route.0.capPct': '30', 'route.0.fallback': '900', 'route.0.maxCabin': 'premium',
      });
    }
    if (blockZs) form.blockedCarriers = [...new Set([...(standard.form.blockedCarriers || []), 'ZS'])];
    const parts = [route && 'Premium economy on Cairo to London', blockZs && 'Sahara Wings (ZS) blocked'].filter(Boolean);
    await svc.savePolicy(as('owner'), 'standard', { rev: standard.rev, note: `Demo policy: ${parts.join(', and ')}.`, form });
  }

  // Trips leave three to five weeks from today (company time); budgets cover this quarter and theirs.
  const today = tz.localDate(org.timezone, now());
  const tripDates = offset => ({ depart: addDays(today, offset), return: addDays(today, offset + 4) });
  const periods = [...new Set([currentPeriodKey(org, now()), ...[21, 34].map(o => periodKey(tripDates(o).depart, org.settings.budgetPeriod))])];
  for (const [name, amount] of Object.entries(BUDGETS)) {
    for (const key of periods) await svc.setBudget(as('finance'), departments[name].id, key, null, amount);
  }

  // Trip requests, through the same service methods the pages call.
  const requests = [];
  const rowsOf = (sv, leg) => (sv.legs[leg] ? sv.legs[leg].rows : []);
  const pickKey = (sv, leg, f, what) => {
    const hit = rowsOf(sv, leg).find(f);
    if (!hit) throw new Error(`The demo inventory has no ${what} for the seed.`);
    return hit.row.key;
  };
  const query = (offset, cabin) => ({ from: 'CAI', to: 'LHR', ...tripDates(offset), hotel: '1', cabin });
  const within = r => r.row.available && r.evaluation.status === 'within';
  // Out of policy but not blocked: Business class above the policy's cabin.
  const outOf = r => r.row.available && r.evaluation.status === 'out';
  const draftTrip = async (service, key, { offset, cabin = 'economy', purpose }) => {
    const q = query(offset, cabin);
    const sv = await service.searchTrip(as(key), q);
    const selection = cabin === 'economy'
      ? {
        out: pickKey(sv, 'out', within, 'flight inside the policy'),
        back: pickKey(sv, 'back', within, 'return flight inside the policy'),
        hotelKey: pickKey(sv, 'hotel', r => within(r) && r.row.stars === 3, '3-star hotel inside the policy'),
      }
      : {
        out: pickKey(sv, 'out', outOf, 'business-class flight'),
        back: pickKey(sv, 'back', outOf, 'business-class return'),
        hotelKey: pickKey(sv, 'hotel', r => r.row.available && r.row.stars === 5 && r.evaluation.status !== 'blocked', '5-star hotel'),
      };
    return service.createRequest(as(key), { query: q, selection, purpose });
  };
  const send = async (service, key, r, reason = REASON) => service.submit(as(key), r.id, {
    rev: r.rev, ...(r.evaluation.status === 'within' ? {} : { reason, category: 'client_meeting' }),
  });
  const current = async (key, rid) => (await svc.getRequest(as(key), rid)).request;
  const note = (r, traveler) => requests.push({ id: r.id, company: DEMO_COMPANY, traveler: users[traveler].name, purpose: r.purpose, status: r.status });

  // Test scenario: expired. Made and sent under a clock set two days back, so its approval window (the
  // company's 24 hours at the time) has run out by now. Nothing writes the expiry: the pages show it expired.
  let r;
  if (seedTrips) {
    const past = () => new Date(now().getTime() - 2 * DAY_MS);
    const pastSvc = new BusinessService({
      repo: new Repo({ store, now: past, log }), accounts, config, now: past, log, inventory: svc.inventory,
      composer: new TripComposer({ inventory: svc.inventory, now: past }), policy: svc.policy, alternatives: svc.alternatives, explainer: svc.explainer,
    });
    r = await draftTrip(pastSvc, 'emma', { offset: 30, cabin: 'business', purpose: `${TEST_SCENARIO}: the approval window ran out` });
    r = (await send(pastSvc, 'emma', r)).request;
    note({ ...r, status: svc.policy.effectiveStatus(r, now().toISOString(), org.timezone) }, 'emma');
  }

  // Then approvers get 7 days (Settings, 4 to 168 hours), so the requests below (and any made on the
  // preview) stay waiting for a week after it starts.
  const fresh = await svc.getOrg(as('owner'));
  await svc.saveSettings(as('owner'), { approvalHours: '168', rev: fresh.rev });
  if (!seedTrips) {
    say(log, `[demo] ${NO_TRIPS[priceSource] || NO_TRIPS.none} The companies, people, budgets and policy are ready: sign in as an employee to search for a trip.`);
  } else {
    // 1. Inside the policy: approved by policy, with its budget hold.
    r = await draftTrip(svc, 'ezra', { offset: 21, purpose: 'Client workshop in London' });
    note((await send(svc, 'ezra', r)).request, 'ezra');
    // 2. Out of policy, waiting for the manager.
    r = await draftTrip(svc, 'esme', { offset: 22, cabin: 'business', purpose: 'Board meeting in London' });
    note((await send(svc, 'esme', r)).request, 'esme');
    // 3. A cheaper alternative used, still out of policy, then approved by the manager.
    r = await draftTrip(svc, 'eli', { offset: 23, cabin: 'business', purpose: 'Partner summit in London' });
    const cheaper = (r.alternatives || []).find(a => a.evaluation && a.evaluation.status === 'out');
    if (cheaper) r = await svc.swap(as('eli'), r.id, { altId: cheaper.id, rev: r.rev });
    r = (await send(svc, 'eli', r)).request;
    await svc.decide(as('salesManager'), r.id, { action: 'approve', rev: r.rev });
    note(await current('eli', r.id), 'eli');
    // 4. Denied, with the manager's reason.
    r = await draftTrip(svc, 'emma', { offset: 24, cabin: 'business', purpose: 'Sales conference in London' });
    r = (await send(svc, 'emma', r)).request;
    await svc.decide(as('salesManager'), r.id, { action: 'deny', note: 'Please fly Economy for this one; the conference is a short trip.', rev: r.rev });
    note(await current('emma', r.id), 'emma');
    // 5. Approved by policy, then cancelled by the traveler (the budget hold is released).
    r = (await send(svc, 'ezra', await draftTrip(svc, 'ezra', { offset: 25, purpose: 'Team offsite in London' }))).request;
    await svc.cancel(as('ezra'), r.id, { rev: r.rev });
    note(await current('ezra', r.id), 'ezra');
    // 6. Waiting, with a question from the manager.
    r = (await send(svc, 'esme', await draftTrip(svc, 'esme', { offset: 26, cabin: 'business', purpose: 'Product launch in London' }))).request;
    await svc.message(as('engManager'), r.id, { text: 'Could you share the launch agenda? I want to check the dates before I decide.' });
    note(await current('esme', r.id), 'esme');
    // 7. A draft out of policy, with its cheaper alternatives, not sent yet.
    note(await draftTrip(svc, 'eli', { offset: 27, cabin: 'business', purpose: 'Customer visit in London' }), 'eli');

    // 8. Test scenario: sent back because the price changed. The draft is made at today's demo price; then the
    //    hotel provider is wrapped so this one room on these dates prices $29 more, and sending it re-checks the
    //    price and returns it to the traveler with the old and new totals. The wrap stays, so sending it again
    //    goes through at the new price.
    r = await draftTrip(svc, 'ezra', { offset: 34, purpose: `${TEST_SCENARIO}: the hotel price changed before sending` });
    const hotelKey = /^h\.(.+)\|([^|]+)$/.exec(r.selection.hotel || r.selection.hotelKey || '');
    if (!hotelKey) throw new Error('The price-change scenario needs a hotel in its trip.');
    const stay = r.query.hotel;
    svc.inventory.hotels = priceStep(svc.inventory.hotels, { offerId: hotelKey[1], optionId: hotelKey[2], checkIn: stay.checkIn, checkOut: stay.checkOut }, PRICE_STEP_CENTS);
    say(log, `[demo] Test scenario: one demo hotel room in ${stay.city} for ${stay.checkIn} to ${stay.checkOut} now prices $29 more, so "${r.purpose}" is sent back when it is sent.`);
    const repriced = await send(svc, 'ezra', r);
    if (repriced.outcome !== 'repriced') throw new Error(`The price-change scenario was ${repriced.outcome}, not sent back.`);
    note(repriced.request, 'ezra');
  }

  // The second company, which shares one employee (the company switcher).
  const second = await svc.createCompany({ user: users.secondOwner }, { name: SECOND_COMPANY, size: '1-10 people', timezone: 'Africa/Cairo', ack: '1' });
  const org2 = await confirm(second.org);
  const shared = PEOPLE.find(p => p.key === SHARED);
  const { token } = await svc.invite({ org: { id: org2.id }, user: users.secondOwner }, { email: shared.email, role: 'employee' });
  await svc.acceptInvite({ user: users[SHARED] }, token);

  // Who to sign in as, read back from the store: each account's role in each company as the company holds it.
  for (const [company, ownerKey] of [[org, 'owner'], [org2, 'secondOwner']]) {
    const people = await svc.listMembers({ org: { id: company.id }, user: users[ownerKey] });
    for (const m of people.members) {
      if (m.status !== 'active') continue;
      let row = roster.find(x => x.email === m.email);
      if (!row) { row = { email: m.email, name: m.name, roles: [] }; roster.push(row); }
      row.roles.push({ company: company.name, role: m.roleLabel || ROLE_LABELS[m.role] || m.role });
    }
  }
  const order = [adminUser.email, ...[...PEOPLE, SECOND_OWNER].map(p => p.email)];
  roster.sort((x, y) => order.indexOf(x.email) - order.indexOf(y.email));
  const scenarios = requests.filter(x => x.purpose.startsWith(TEST_SCENARIO))
    .map(x => ({ id: x.id, purpose: x.purpose, traveler: x.traveler, path: `/business/o/${org.id}/trips/${x.id}` }));

  say(log, `[demo] Business demo: ${DEMO_COMPANY} (${PEOPLE.length} people, ${requests.length} trip requests) and ${SECOND_COMPANY}, ${roster.length} demo accounts.`);
  say(log, `[demo] Sign in at /business/signin as any of these demo accounts (${source === 'preview' ? "each uses the preview gate's own password" : 'their password is printed by the command only'}):`);
  for (const a of roster) say(log, `[demo]   ${a.email}: ${a.roles.map(x => (x.company ? `${x.role}, ${x.company}` : x.role)).join('; ')}`);
  for (const x of scenarios) say(log, `[demo] ${x.purpose} (${x.traveler}'s trip): ${x.path}`);
  return {
    companies: [{ id: org.id, name: DEMO_COMPANY }, { id: org2.id, name: SECOND_COMPANY }],
    accounts: roster,
    passwordSource: source,
    requests,
    scenarios,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The command

/** The command's words for where the demo's prices come from. */
const PRICE_WORDS = Object.freeze({
  demo: 'demo prices', sandbox: "prices from the suppliers' test systems", live: 'prices from the suppliers', none: 'no supplier connected',
});

const USAGE = 'Usage: APP_ENV=development node scripts/business-demo.js [--port 4400] [--production-preview 4401]';

/**
 * @param {string[]} argv
 * @returns {{ port: number, prodPort: number|null }|{ error: string }}
 */
function parseArgs(argv) {
  let port = 4400, prodPort = null;
  const portOf = v => (/^\d{1,5}$/.test(String(v)) && Number(v) <= 65535 ? Number(v) : NaN);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (flag !== '--port' && flag !== '--production-preview') return { error: `Unknown option "${a}".` };
    const value = inline !== undefined ? inline : argv[i += 1];
    const n = portOf(value);
    if (!Number.isFinite(n)) return { error: `${flag} needs a port number.` };
    if (flag === '--port') port = n; else prodPort = n;
  }
  if (prodPort !== null && prodPort !== 0 && prodPort === port) return { error: 'Use two different ports.' };
  return { port, prodPort };
}

/** Listen on 127.0.0.1 (port 0 picks a free one). */
function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Run the command: refuse outside development or off the memory store, start the app (and the production
 * preview), seed, print who to sign in as.
 * @param {{ argv?: string[], env?: object, out?: { log: Function, error: Function } }} [opts]
 * @returns {Promise<{ code: number, close?: () => Promise<void>, urls?: { dev: string, prod: string|null }, result?: object }>}
 */
async function main({ argv = process.argv.slice(2), env = process.env, out = console } = {}) {
  const args = parseArgs(argv);
  if (args.error) { out.error(`${args.error}\n${USAGE}`); return { code: 2 }; }
  if (env.APP_ENV !== 'development') {
    out.error(`The Business demo runs only with APP_ENV=development (here: ${env.APP_ENV ? `"${String(env.APP_ENV).slice(0, 20)}"` : 'unset'}).\n${USAGE}`);
    return { code: 1 };
  }
  if (env.DATABASE_URL && env.DATABASE_URL !== 'memory') {
    out.error('The Business demo only fills the in-memory store: unset DATABASE_URL (or set DATABASE_URL=memory).');
    return { code: 1 };
  }
  if (env.DATABASE_HOST) {
    out.error('The Business demo only fills the in-memory store: unset DATABASE_HOST.');
    return { code: 1 };
  }
  const { loadConfig } = require('../server/config');
  const { createApp } = require('../server/app');
  const { MemoryStore } = require('../server/booking/MemoryStore');
  const quiet = { info() {}, log() {}, warn: m => out.error(m), error: (...a) => out.error(...a) };

  const devEnv = { ...env, ENABLE_BUSINESS: 'true', DATABASE_URL: 'memory', ADMIN_EMAILS: env.ADMIN_EMAILS || DEMO_ADMIN_EMAIL, PORT: String(args.port) };
  const config = loadConfig(devEnv);
  const built = await createApp(config, { log: quiet });
  if (built.store.kind !== 'memory') {
    await built.store.close();
    out.error('The Business demo only fills the in-memory store.');
    return { code: 1 };
  }
  const servers = [];
  const close = async () => { for (const s of servers) await new Promise(r => s.close(r)); };
  let result;
  try {
    result = await seed({ ...built, config, log: { info: m => out.log(m), warn: m => out.error(m), error: m => out.error(m) }, now: built.ctx.now, env });
    servers.push(await listen(built.app, args.port));
  } catch (e) {
    await close();
    throw e;
  }
  const devUrl = `http://127.0.0.1:${servers[0].address().port}`;

  let prodUrl = null;
  if (args.prodPort !== null) {
    // The production config, on a throwaway in-memory store: no supplier, trips off, Business on. HTTPS_ONLY is
    // forced off only here, so the page opens over plain http on this computer; production itself refuses that.
    const prodConfig = loadConfig({
      APP_ENV: 'production', DATABASE_URL: 'postgres://production-preview.invalid/unused', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false',
      ADMIN_EMAILS: devEnv.ADMIN_EMAILS, PORT: String(args.prodPort),
    });
    prodConfig.httpsOnly = false;
    const prod = await createApp(prodConfig, { log: quiet, store: new MemoryStore() });
    try {
      servers.push(await listen(prod.app, args.prodPort));
    } catch (e) {
      await close();
      throw e;
    }
    prodUrl = `http://127.0.0.1:${servers[1].address().port}`;
  }

  out.log('');
  const prices = PRICE_WORDS[built.business.inventory && built.business.inventory.source] || PRICE_WORDS.none;
  out.log(`Tripelyx Business demo: ${devUrl}/business  (development, ${prices}; nothing is booked, charged or emailed)`);
  if (prodUrl) out.log(`Production preview:     ${prodUrl}/business/start  (no supplier: "Supplier not connected yet"; nothing seeded)`);
  out.log(`Sign in at ${devUrl}/business/signin with the demo accounts listed above.`);
  out.log(result.passwordSource === 'default' ? `Password for every demo account: ${DEMO_PASSWORD}` : 'Password for every demo account: the preview password you set.');
  for (const x of result.scenarios) out.log(`${x.purpose}: ${devUrl}${x.path}`);
  out.log('Stop with Ctrl+C.');
  return { code: 0, close, urls: { dev: devUrl, prod: prodUrl }, result };
}

if (require.main === module) {
  main().then(r => {
    if (r.code !== 0) { process.exitCode = r.code; return; }
    const stop = () => { r.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }, e => {
    console.error(`[demo] ${e && e.message ? e.message.split('\n')[0] : e}`);
    process.exitCode = 1;
  });
}

module.exports = {
  seed, main, parseArgs, priceStep, demoPassword, assertDemoAllowed,
  DEMO_PASSWORD, DEMO_COMPANY, SECOND_COMPANY, TEST_SCENARIO, DEMO_ADMIN_EMAIL, PRICE_STEP_CENTS, PEOPLE, SECOND_OWNER, SHARED, NO_TRIPS,
};
