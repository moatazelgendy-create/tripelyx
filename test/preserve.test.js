// Every existing page renders exactly as on the untouched site (a0ea0bc), with Tripelyx Business off; with it on,
// it differs only by what Business adds to the shared chrome (plan §B1, §L Stage 0).
// The baseline is test/fixtures/baseline, written by scripts/capture-baseline.js, which this test shares for the
// env sets, the boot, the requests and the normalising (?v= cache-busters and the copyright year only).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ENVS, PAGES, SIGNED_IN, FIXED_NOW, sha256, stripBusiness, expectedBusinessCounts, freezeDate, bootApp, collect } = require('../scripts/capture-baseline');
const manifest = require('./fixtures/baseline/manifest.json');

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
    const { app, got } = await run(t, { ...env, ...BUSINESS_ON });
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
    if (!want.signedIn) return assert.equal(got.signedIn, null);
    for (const p of SIGNED_IN) {
      const { text, counts } = stripBusiness(got.signedIn[p].text);
      assert.deepEqual(counts, { navItem: 1, headerClass: 1, headerName: 1, footerLink: 1 }, `${envName} ${p} signed in: what Business adds`);
      assert.ok(got.signedIn[p].text.includes('<span class="header-name">Ada</span>'), `${envName} ${p}: the name span`);
      assert.equal(sha256(text), want.signedIn[p].sha256, `${envName} ${p} signed in: nothing else changed`);
    }
  });
}
