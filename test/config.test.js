const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, publicConfig } = require('../server/config');
const { createRegistry } = require('../server/providers/registry');

test('development defaults: every vertical on, mock providers, test payments', () => {
  const c = loadConfig({});
  assert.equal(c.appEnv, 'development');
  assert.equal(Object.values(c.flags).filter(Boolean).length, 8);
  assert.ok(Object.values(c.providers).every(p => p === 'mock'));
  assert.equal(c.payment.mode, 'test');
  assert.equal(createRegistry(c).enabled().length, 8);
});

test('ENABLE_* flags switch verticals off and the registry skips them', () => {
  const c = loadConfig({ ENABLE_CRUISES: 'false', ENABLE_FLIGHTS: '0' });
  const r = createRegistry(c);
  assert.equal(r.get('cruises'), null);
  assert.equal(r.get('flights'), null);
  assert.ok(r.get('hotels'));
  assert.ok(!publicConfig(c).verticals.some(v => v.key === 'cruises'));
});

test('*_PROVIDER names an adapter; unknown adapters fail at boot', () => {
  const c = loadConfig({ HOTEL_PROVIDER: 'acmebeds' });
  assert.equal(c.providers.hotels, 'acmebeds');
  assert.throws(() => createRegistry(c), /No HotelProvider adapter named "acmebeds"/);
});

test('production refuses demo inventory unless explicitly allowed', () => {
  const env = { APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_HOTELS: 'true' };
  const c = loadConfig(env);
  assert.equal(c.flags.flights, false, 'verticals are off by default in production');
  assert.throws(() => createRegistry(c), /HOTEL_PROVIDER=mock is not allowed in production/);
  const demo = loadConfig({ ...env, ALLOW_DEMO_INVENTORY: 'true' });
  assert.ok(createRegistry(demo).get('hotels'));
});

test('staging and production need their own DATABASE_URL', () => {
  assert.throws(() => loadConfig({ APP_ENV: 'staging' }), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ APP_ENV: 'production' }), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ APP_ENV: 'staging', DATABASE_URL: 'postgres://x/y', DATABASE_ENV: 'production' }), /does not match/);
  assert.ok(loadConfig({ APP_ENV: 'staging', DATABASE_URL: 'postgres://x/y', DATABASE_ENV: 'staging' }));
  assert.ok(loadConfig({ APP_ENV: 'staging', DATABASE_URL: 'memory' }));
  assert.throws(() => loadConfig({ APP_ENV: 'production', DATABASE_URL: 'memory' }), /not allowed/);
});

test('live payments need production, a processor, credentials and no demo inventory', () => {
  assert.throws(() => loadConfig({ PAYMENT_MODE: 'live' }), /only allowed when APP_ENV=production/);
  const prod = { APP_ENV: 'production', DATABASE_URL: 'postgres://x/p', PAYMENT_MODE: 'live' };
  assert.throws(() => loadConfig(prod), /needs PAYMENT_LIVE_PROCESSOR/);
  const full = { ...prod, PAYMENT_LIVE_PROCESSOR: 'paymob', PAYMENT_LIVE_SECRET_KEY: 'sk', PAYMENT_LIVE_WEBHOOK_SECRET: 'wh' };
  assert.equal(loadConfig(full).payment.mode, 'live');
  assert.throws(() => loadConfig({ ...full, ALLOW_DEMO_INVENTORY: 'true' }), /demo inventory must never take real money/);
  assert.throws(() => loadConfig({ PAYMENT_MODE: 'sandbox' }), /"test" or "live"/);
});

test('publicConfig exposes no secrets', () => {
  const c = loadConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://u:secretpw@h/p', PAYMENT_MODE: 'live', PAYMENT_LIVE_PROCESSOR: 'paymob', PAYMENT_LIVE_SECRET_KEY: 'sk_live_123', PAYMENT_LIVE_WEBHOOK_SECRET: 'whsec' });
  const json = JSON.stringify(publicConfig(c));
  for (const s of ['secretpw', 'sk_live_123', 'whsec', 'paymob']) assert.ok(!json.includes(s), `leaks ${s}`);
});

test('database URL can be assembled from separate parts (AWS Secrets Manager)', () => {
  const c = loadConfig({ APP_ENV: 'staging', DATABASE_ENV: 'staging', DATABASE_HOST: 'db.example.internal', DATABASE_NAME: 'tripelyx', DATABASE_USER: 'tx', DATABASE_PASSWORD: 'p@ss/word' });
  assert.equal(c.databaseUrl, 'postgres://tx:p%40ss%2Fword@db.example.internal:5432/tripelyx');
  assert.throws(() => loadConfig({ APP_ENV: 'staging', DATABASE_HOST: 'h' }), /DATABASE_NAME/);
});

test('HTTPS_ONLY defaults on outside development and production refuses to turn it off', () => {
  const db = { DATABASE_URL: 'postgres://u:p@h/db' };
  assert.equal(loadConfig({}).httpsOnly, false);
  assert.equal(loadConfig({ APP_ENV: 'staging', ...db }).httpsOnly, true);
  assert.equal(loadConfig({ APP_ENV: 'staging', HTTPS_ONLY: 'false', ...db }).httpsOnly, false);
  assert.throws(() => loadConfig({ APP_ENV: 'production', HTTPS_ONLY: 'false', ...db }), /HTTPS_ONLY=false/);
});

test('Tripelyx Business: off in every APP_ENV unless ENABLE_BUSINESS=true, never a vertical or public', () => {
  const db = { DATABASE_URL: 'postgres://u:p@h/db' };
  assert.equal(loadConfig({}).business.enabled, false, 'development');
  assert.equal(loadConfig({ APP_ENV: 'staging', ...db }).business.enabled, false, 'staging (the live site)');
  assert.equal(loadConfig({ APP_ENV: 'production', ...db }).business.enabled, false, 'production');
  for (const APP_ENV of ['development', 'staging', 'production']) {
    assert.equal(loadConfig({ APP_ENV, ENABLE_BUSINESS: 'true', ...db }).business.enabled, true, `${APP_ENV}: ENABLE_BUSINESS=true`);
    assert.equal(loadConfig({ APP_ENV, ENABLE_BUSINESS: 'false', ...db }).business.enabled, false, `${APP_ENV}: ENABLE_BUSINESS=false`);
    assert.equal(loadConfig({ APP_ENV, ENABLE_BUSINESS: '', ...db }).business.enabled, false, `${APP_ENV}: ENABLE_BUSINESS empty`);
  }
  const c = loadConfig({});
  assert.deepEqual(c.business, {
    enabled: false, selfServe: false, inviteDays: 7, maxOrgsPerUser: 3, approvalHours: 24, writeLimit: 300,
    computeLimit: 30, authLimit: 20, explainer: 'rules',
  });
  assert.equal(loadConfig({ BUSINESS_SELF_SERVE: 'true' }).business.selfServe, true);
  assert.equal(loadConfig({ BUSINESS_INVITE_DAYS: '14' }).business.inviteDays, 14);
  assert.equal(loadConfig({ BUSINESS_AUTH_LIMIT: '50' }).business.authLimit, 50);
  assert.equal(Object.values(c.flags).filter(Boolean).length, 8, 'still exactly 8 vertical flags');
  assert.ok(!('business' in c.flags));
  const pub = JSON.stringify(publicConfig(c));
  assert.ok(!('business' in publicConfig(c)) && !/business|selfServe|approvalHours|explainer/i.test(pub), 'publicConfig has no business settings');
});

test('Tripelyx Business numbers must be whole numbers of 1 or more', () => {
  const names = ['BUSINESS_INVITE_DAYS', 'BUSINESS_MAX_ORGS_PER_USER', 'BUSINESS_APPROVAL_HOURS', 'BUSINESS_WRITE_LIMIT',
    'BUSINESS_COMPUTE_LIMIT', 'BUSINESS_AUTH_LIMIT'];
  for (const name of names) {
    for (const bad of ['soon', '-5', '1.5', '0']) {
      assert.throws(() => loadConfig({ [name]: bad }), new RegExp(`${name} must be a whole number`), `${name}=${bad}`);
    }
    assert.ok(loadConfig({ [name]: '' }), `${name} empty falls back to the default`);
  }
  // The advisor-era settings are gone: setting them changes nothing.
  for (const gone of ['BUSINESS_SHARE_LINK_DAYS', 'BUSINESS_FOLLOW_UP_DAYS', 'BUSINESS_CLIENT_WRITE_LIMIT', 'BUSINESS_LOGO_MAX_KB']) {
    assert.deepEqual(loadConfig({ [gone]: '9' }).business, loadConfig({}).business, gone);
  }
});

test('Tripelyx Business approval hours are 4 to 168, and the only explainer is the rule-based one', () => {
  for (const ok of ['4', '24', '72', '168']) assert.equal(loadConfig({ BUSINESS_APPROVAL_HOURS: ok }).business.approvalHours, Number(ok));
  for (const bad of ['1', '3', '169', '1000']) {
    assert.throws(() => loadConfig({ BUSINESS_APPROVAL_HOURS: bad }), /BUSINESS_APPROVAL_HOURS must be from 4 to 168/, bad);
  }
  assert.equal(loadConfig({ BUSINESS_EXPLAINER: 'rules' }).business.explainer, 'rules');
  assert.equal(loadConfig({ BUSINESS_EXPLAINER: '' }).business.explainer, 'rules');
  assert.equal(loadConfig({ BUSINESS_EXPLAINER: ' Rules ' }).business.explainer, 'rules', 'case and spaces are forgiven');
  for (const bad of ['model', 'ai', 'rule', 'none']) {
    assert.throws(() => loadConfig({ BUSINESS_EXPLAINER: bad }), /BUSINESS_EXPLAINER must be one of: rules/, bad);
  }
});
