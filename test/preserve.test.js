// Every existing page renders exactly as on the untouched site (a0ea0bc), with Tripelyx Business off; with it on,
// it differs only by what Business adds to the shared chrome (plan §B1, §L Stage 0).
// The baseline is test/fixtures/baseline, written by scripts/capture-baseline.js, which this test shares for the
// env sets, the boot, the requests and the normalising (?v= cache-busters and the copyright year only).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ENVS, PAGES, SIGNED_IN, FIXED_NOW, sha256, normalise, stripBusiness, expectedBusinessCounts, freezeDate, bootApp, collect } = require('../scripts/capture-baseline');
const manifest = require('./fixtures/baseline/manifest.json');
const { SANDBOX_ENV, BAD_SUPPLIER_ENVS, blockSupplierHosts } = require('./supplier-fetch');
const { seedUser, seedOrg, seedMember, client } = require('./business-helpers');

const ROOT = path.join(__dirname, '..');
const BUSINESS_ON = { ENABLE_BUSINESS: 'true' };

// robots.txt and sitemap.xml (served only with trips on) gain one line each with Business on (plan §B1);
// everything else in them is unchanged. With trips off they are the app's 404 page, like any other.
function stripBusinessLines(p, text, base) {
  if (/^<!doctype html>/.test(text)) return { text, changed: null };
  if (p === '/robots.txt') return { text: text.replace('Disallow: /my-trips\nDisallow: /business/\n', 'Disallow: /my-trips\n'), changed: text.includes('Disallow: /business/\n') };
  if (p === '/sitemap.xml') {
    const line = `  <url><loc>${base}/business</loc></url>\n`;
    return { text: text.replace(line, ''), changed: text.includes(line) };
  }
  return { text, changed: null };
}

async function run(t, env) {
  const restore = freezeDate(FIXED_NOW);
  t.after(restore);
  const app = await bootApp(ROOT, env);
  t.after(app.close);
  return { app, got: await collect(app, { only: 'pages' }) };
}

test('the baseline covers every page the plan lists, in all three env sets', () => {
  assert.equal(manifest.commit, 'a0ea0bc');
  assert.equal(manifest.fixedNow, FIXED_NOW);
  assert.deepEqual(Object.keys(manifest.envs), Object.keys(ENVS));
  for (const [name, env] of Object.entries(ENVS)) {
    assert.deepEqual(manifest.envs[name].env, env, name);
    assert.deepEqual(Object.keys(manifest.envs[name].pages), PAGES, name);
    assert.equal(manifest.envs[name].pages['/business'].status, 404, `${name}: /business did not exist`);
  }
  assert.deepEqual(Object.keys(manifest.envs.dev.signedIn), SIGNED_IN);
  assert.deepEqual(Object.keys(manifest.envs.live.signedIn), SIGNED_IN);
  assert.equal(manifest.envs.tripsOff.signedIn, null, 'no accounts with trips off');
  assert.equal(PAGES.length, 16);
});

/**
 * With Business on, every page differs from the baseline only by what Business adds to the shared chrome (plan
 * §B1). Shared by the plain Business-on run and the run with the real suppliers configured (design §1.6).
 */
async function checkBusinessOn(t, envName, env) {
  const { app, got } = await run(t, env);
  assert.ok(app.ctx.business && app.ctx.businessNav, 'Business runs');
  const want = manifest.envs[envName];
  const base = app.config.publicBaseUrl || '';
  for (const p of PAGES) {
    if (p === '/business') {
      assert.equal(got.pages[p].status, 200, `${envName}: /business is the company page with Business on`);
      continue;
    }
    assert.equal(got.pages[p].status, want.pages[p].status, `${envName} ${p}: status`);
    assert.equal(got.pages[p].type, want.pages[p].type, `${envName} ${p}: content type`);
    const lines = stripBusinessLines(p, got.pages[p].text, base);
    if (lines.changed !== null) {
      assert.equal(lines.changed, true, `${envName} ${p}: the Business line`);
      assert.equal(sha256(lines.text), want.pages[p].sha256, `${envName} ${p}: nothing else changed`);
      continue;
    }
    const { text, counts } = stripBusiness(got.pages[p].text);
    assert.deepEqual(counts, expectedBusinessCounts(got.pages[p].text), `${envName} ${p}: what Business adds`);
    assert.equal(counts.headerName, 0, `${envName} ${p}: signed out`);
    assert.equal(sha256(text), want.pages[p].sha256, `${envName} ${p}: nothing else changed`);
  }
  if (!want.signedIn) {
    assert.equal(got.signedIn, null);
    return app;
  }
  for (const p of SIGNED_IN) {
    const { text, counts } = stripBusiness(got.signedIn[p].text);
    assert.deepEqual(counts, { navItem: 1, headerClass: 1, headerName: 1, footerLink: 1 }, `${envName} ${p} signed in: what Business adds`);
    assert.ok(got.signedIn[p].text.includes('<span class="header-name">Ada</span>'), `${envName} ${p}: the name span`);
    assert.equal(sha256(text), want.signedIn[p].sha256, `${envName} ${p} signed in: nothing else changed`);
  }
  return app;
}

for (const [envName, env] of Object.entries(ENVS)) {
  test(`${envName}, Business off by default: every page is byte-identical to the baseline`, async t => {
    const { app, got } = await run(t, env);
    assert.equal(app.ctx.business, null, 'Business is off unless ENABLE_BUSINESS=true');
    assert.equal(app.ctx.businessNav, false);
    const want = manifest.envs[envName];
    for (const p of PAGES) {
      assert.equal(got.pages[p].status, want.pages[p].status, `${envName} ${p}: status`);
      assert.equal(got.pages[p].type, want.pages[p].type, `${envName} ${p}: content type`);
      assert.equal(got.pages[p].sha256, want.pages[p].sha256, `${envName} ${p}: the page changed`);
      assert.doesNotMatch(got.pages[p].text, /site-header-biz|header-name|href="\/business"/, `${envName} ${p}: nothing of Business`);
    }
    if (!want.signedIn) return assert.equal(got.signedIn, null);
    for (const p of SIGNED_IN) {
      assert.equal(got.signedIn[p].status, want.signedIn[p].status, `${envName} ${p} signed in: status`);
      assert.equal(got.signedIn[p].sha256, want.signedIn[p].sha256, `${envName} ${p} signed in: the page changed`);
      assert.ok(got.signedIn[p].text.includes('Ada'), `${envName} ${p}: signed in as Ada`);
    }
  });

  test(`${envName}, ENABLE_BUSINESS=false: the same bytes`, async t => {
    const { got } = await run(t, { ...env, ENABLE_BUSINESS: 'false' });
    const want = manifest.envs[envName];
    for (const p of PAGES) assert.equal(got.pages[p].sha256, want.pages[p].sha256, `${envName} ${p}`);
    for (const p of want.signedIn ? SIGNED_IN : []) assert.equal(got.signedIn[p].sha256, want.signedIn[p].sha256, `${envName} ${p} signed in`);
  });

  test(`${envName}, Business on: every page differs only by the Business menu item, header class, name span and trip footer link`, async t => {
    await checkBusinessOn(t, envName, { ...env, ...BUSINESS_ON });
  });
}

// Round 1 of the real suppliers (design §1.6, §7.4): configuring them changes nothing outside Business, and no
// page here ever calls a supplier.
for (const [envName, env] of Object.entries(ENVS)) {
  test(`${envName}, Business on with the sandbox suppliers configured: the same pages as Business on, and no supplier call`, async t => {
    const block = blockSupplierHosts();
    t.after(block.restore);
    const app = await checkBusinessOn(t, envName, { ...env, ...SANDBOX_ENV });
    assert.equal(app.business.inventory.status, 'sandbox');
    assert.equal(app.business.inventory.flights.name, 'DuffelFlights');
    assert.equal(block.count(), 0, 'no supplier call');
  });
}

const HEADERS = { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
const page = async (base, p, headers = {}) => {
  const res = await fetch(base + p, { headers: { ...HEADERS, ...headers }, redirect: 'manual' });
  return { status: res.status, text: normalise(await res.text()) };
};

test('every bad supplier setting: the app boots, / and /ai-travel-agent are unchanged, Business says "Supplier not connected yet", and the problem names no key', async t => {
  const block = blockSupplierHosts();
  t.after(block.restore);
  const restore = freezeDate(FIXED_NOW);
  t.after(restore);
  const want = manifest.envs.dev.pages;
  for (const [label, bad] of BAD_SUPPLIER_ENVS) {
    const env = { ...SANDBOX_ENV, ...bad };
    const app = await bootApp(ROOT, env);
    try {
      for (const p of ['/', '/ai-travel-agent']) {
        const got = await page(app.base, p);
        assert.equal(got.status, want[p].status, `${label} ${p}: status`);
        assert.equal(sha256(stripBusiness(got.text).text), want[p].sha256, `${label} ${p}: unchanged`);
      }
      const inv = app.business.inventory;
      assert.equal(inv.status, 'none', label);
      assert.equal(inv.flights, null, `${label}: never demo instead`);
      assert.equal(typeof inv.problem, 'string', label);
      for (const v of [env.DUFFEL_ACCESS_TOKEN, env.LITEAPI_API_KEY].filter(Boolean)) assert.ok(!inv.problem.includes(v), `${label}: the problem names no key`);
      // A member opens the trip form: the "Supplier not connected yet" panel, once.
      const owner = await seedUser(app, { name: 'Olivia Owner' });
      const org = await seedOrg(app, owner);
      const sam = await seedMember(app, org, 'employee', { name: 'Sam Rivera', departmentId: org.general.id });
      const res = await client(app.base, sam.cookie).get(`/business/o/${org.id}/trips/new`, { headers: HEADERS });
      assert.equal(res.status, 200, `${label}: the trip form`);
      assert.equal(res.text.split('Supplier not connected yet.').length - 1, 1, `${label}: Supplier not connected yet`);
    } finally {
      await app.close();
    }
  }
  assert.equal(block.count(), 0, 'no supplier call');
});
