// www as deployed at stage L2 (go-live design §5.2, §5.3): both supplier key secrets hold "unset" until the owner
// pastes the live keys. Business must then be exactly what 49a9ccb (stage L0) served: status 'none', and every
// Business page, in every role, the same answer byte for byte. The record of 49a9ccb is
// test/fixtures/golive/business-none-49a9ccb.json, written by scripts/capture-business-sweep.js from an
// untouched export of 49a9ccb; this test walks the same pages, with the same seed, on the site as built now.
//
// The one difference allowed is the one L2 adds on purpose: the platform admin's /admin/business gets a
// Suppliers panel that says both keys are not set (go-live design §5.4). The test checks that panel, takes it
// out, and the rest of the page must match. No supplier host is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sweep, envs } = require('../scripts/capture-business-sweep');
const { blockSupplierHosts } = require('./supplier-fetch');
const recorded = require('./fixtures/golive/business-none-49a9ccb.json');

const ROOT = path.join(__dirname, '..');
/** The Suppliers panel of /admin/business (views/business/platform.js), as it renders. */
const PANEL = /<section class="bz-section bz-card bz-stack" aria-labelledby="bz-plat-live">[\s\S]*?<\/section>/;

/** Every page whose answer differs from the record, with both lines, and the pages only one side has. */
function differences(now, then) {
  const out = [];
  for (const key of new Set([...Object.keys(then), ...Object.keys(now)])) {
    if (now[key] !== then[key]) out.push(`${key}\n  49a9ccb: ${then[key] || '(not reached)'}\n  now:     ${now[key] || '(not reached)'}`);
  }
  return out;
}

test('the record of 49a9ccb is what it says: www settings of L0, status none, every role and the platform admin', () => {
  assert.equal(recorded.site, '49a9ccb');
  assert.equal(recorded.env, 'l0');
  assert.equal(recorded.status, 'none');
  assert.equal(recorded.count, Object.keys(recorded.pages).length);
  assert.ok(recorded.count > 500, `${recorded.count} pages`);
  const who = new Set(Object.keys(recorded.pages).map(k => k.split(' /')[0].replace(/ POST$/, '')));
  for (const w of ['Acme owner', 'Acme admin', 'Acme finance', 'Acme manager', 'Acme employee', 'Globex owner', 'Globex employee', 'stranger', 'Pat Both', 'platform admin']) {
    assert.ok(who.has(w), `the record walks as ${w}`);
  }
  for (const line of Object.values(recorded.pages)) assert.match(line, /^\d{3} \S+ \S+ [0-9a-f]{64}$/);
});

// The secrets as the stack makes them ("unset"), and empty (a value cleared by hand): the same site either way.
for (const [label, value] of [['holding "unset"', 'unset'], ['empty', '']]) {
  test(`www with both key secrets ${label}: every Business page in every role is the answer 49a9ccb gave (status none); only the platform admin's Suppliers panel is new`, { timeout: 300000 }, async t => {
    const blocked = blockSupplierHosts();
    t.after(() => blocked.restore());
    const { unset } = envs(ROOT);
    assert.deepEqual(
      [unset.DUFFEL_ACCESS_TOKEN, unset.LITEAPI_API_KEY, unset.BUSINESS_SUPPLIER_LIVE, unset.BUSINESS_ALLOW_SUPPLIER_TEST, unset.BUSINESS_DEMO_INVENTORY],
      ['unset', 'unset', 'true', 'false', 'false'], "infra/app.yaml's www settings at L2, keys not pasted yet");
    const env = { ...unset, DUFFEL_ACCESS_TOKEN: value, LITEAPI_API_KEY: value };
    const panels = [];
    const now = await sweep(ROOT, env, {
      adjust(key, text) {
        if (!/^platform admin \/admin\/business(\?|$)/.test(key)) return text;
        const m = text.match(PANEL);
        assert.ok(m, `${key}: the Suppliers panel`);
        panels.push([key, m[0]]);
        return text.replace(PANEL, '');
      },
    });
    assert.equal(now.status, 'none');
    const diff = differences(now.pages, recorded.pages);
    assert.deepEqual(diff, [], `${diff.length} pages differ from 49a9ccb:\n${diff.slice(0, 20).join('\n')}`);
    assert.equal(Object.keys(now.pages).length, recorded.count);
    assert.equal(blocked.count(), 0, 'no supplier call');

    // The panel: live search off, both keys not set, what to do, nothing to press, no key or placeholder shown.
    assert.ok(panels.length >= 7, `${panels.length} admin pages`);
    for (const [key, html] of panels) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      assert.match(text, /Suppliers Live search is off/, key);
      assert.match(text, /A supplier setting needs attention: DUFFEL_ACCESS_TOKEN is not set\./, key);
      assert.match(text, /Duffel \(flights\) Not set Paste the live key in AWS Secrets Manager \(the README says how\), then restart the service\./, key);
      assert.match(text, /LiteAPI \(hotels\) Not set/, key);
      assert.match(text, /Calls today: 0 of 500\. Each company can make up to 100\./, key);
      assert.doesNotMatch(html, /<form|<button|>unset<|—/, `${key}: nothing to press, no placeholder, no em dash`);
    }
  });
}

test('www without the L2 settings (as 49a9ccb ran) is 49a9ccb byte for byte, the platform admin\'s page too', { timeout: 300000 }, async t => {
  const blocked = blockSupplierHosts();
  t.after(() => blocked.restore());
  const now = await sweep(ROOT, envs(ROOT).l0);
  assert.equal(now.status, 'none');
  const diff = differences(now.pages, recorded.pages);
  assert.deepEqual(diff, [], `${diff.length} pages differ from 49a9ccb:\n${diff.slice(0, 20).join('\n')}`);
  assert.equal(blocked.count(), 0, 'no supplier call');
});
