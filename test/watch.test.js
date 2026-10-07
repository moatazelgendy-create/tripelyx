// Price watches: the rule a watch waits for (a drop of at least an amount, any drop, or a total at or
// under an amount), the honest sentence My Trips shows for it, the "Alert" pill that appears only when
// the rule is met, the route that reads the rule as typed, and the saved trip that carries no rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { ruleText, watchMet, watchRule, WATCH_DEFAULT_RULE } = require('../server/trips/service');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { money } = require('../server/views/trips/common');

const QUERY = { b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' };
// Words a watch line must never carry: the product promises no fake scarcity and no urgency.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d|ending soon|book now)\b/i;
const ALERT_PILL = '<span class="tb-delta tb-delta-save">Alert</span>';

// A browser-like client: keeps cookies, follows nothing, sends same-origin form posts.
function client(base) {
  const jar = {};
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = async (path, { method = 'GET', form, headers = {} } = {}) => {
    const h = { cookie: cookies(), 'sec-fetch-site': 'same-origin', ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) { const [kv, ...rest] = sc.split(';'); const [k, v] = kv.split('='); if (!v || rest.some(x => /Max-Age=0/i.test(x))) delete jar[k]; else jar[k] = v; }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  };
  return { req, jar };
}

async function signUp(c, email) {
  const ok = await c.req('/signup', { method: 'POST', form: { name: 'Ada Lovelace', email, password: 'correct horse battery', next: '/my-trips' } });
  assert.equal(ok.status, 303);
}

// The first trip on the results page: its path, its context string, its token and its total, priced now.
async function firstTrip(app, c) {
  const results = await c.req(`/trips?${new URLSearchParams(QUERY)}`);
  assert.equal(results.status, 200);
  const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
  const tripPath = m[1], cx = m[2].replace(/&amp;/g, '&'), token = tripPath.split('/')[2];
  const priced = await app.tripService.price(decodeSpec(token));
  assert.ok(priced, 'the trip prices');
  return { tripPath, cx, token, total: priced.total };
}

test('ruleText says exactly what each rule waits for, and a missing rule is the $100 drop', () => {
  assert.equal(ruleText({ kind: 'drop', amount: 10000 }), 'Alert when the total drops $100 or more');
  assert.equal(ruleText({ kind: 'drop', amount: 5000 }), 'Alert when the total drops $50 or more');
  assert.equal(ruleText({ kind: 'any-drop' }), 'Alert when the same trip gets cheaper');
  assert.equal(ruleText({ kind: 'under', amount: 120000 }), 'Alert when the total is at or under $1,200');
  assert.equal(ruleText(undefined), 'Alert when the total drops $100 or more');
  assert.deepEqual(WATCH_DEFAULT_RULE, { kind: 'drop', amount: 10000 });
  assert.deepEqual(watchRule(undefined), { kind: 'drop', amount: 10000 });
  assert.deepEqual(watchRule({ kind: 'any-drop', amount: 500 }), { kind: 'any-drop' }, 'any drop carries no amount');
  assert.deepEqual(watchRule('any-drop'), { kind: 'any-drop' });
});

test('watchRule refuses every rule outside the three kinds and every amount that is not positive whole cents', () => {
  const refused = input => assert.throws(() => watchRule(input), e => e.name === 'AppError' && e.code === 'invalid_watch' && e.status === 422, JSON.stringify(input));
  refused({ kind: 'magic', amount: 100 });
  refused({ kind: 'drop' });
  refused({ kind: 'under' });
  refused({ kind: 'drop', amount: 0 });
  refused({ kind: 'under', amount: -500 });
  refused({ kind: 'under', amount: 100.5 });
  refused({ kind: 'under', amount: '100' });
  refused({ kind: 'drop', amount: NaN });
  refused({ kind: 'drop', amount: Infinity });
  refused({ kind: 'under', amount: 100000001 });
  refused('drop');
  refused(42);
  assert.deepEqual(watchRule({ kind: 'drop', amount: 1 }), { kind: 'drop', amount: 1 });
  assert.deepEqual(watchRule({ kind: 'under', amount: 100000000 }), { kind: 'under', amount: 100000000 });
});

test('watchMet: a drop rule is met only by a drop of at least the amount, and the sentence carries the exact numbers', () => {
  const rule = { kind: 'drop', amount: 10000 };
  assert.deepEqual(watchMet(rule, 130000, 118000), { met: true, text: 'The total dropped $120 since you saved it: $1,180 now' });
  assert.deepEqual(watchMet(rule, 130000, 120000), { met: true, text: 'The total dropped $100 since you saved it: $1,200 now' }, 'exactly the amount counts');
  assert.deepEqual(watchMet(rule, 130000, 131200), { met: false, text: 'No alert: the total moved +$12 since you saved it, not the $100 drop you asked for' });
  assert.deepEqual(watchMet(rule, 130000, 126000), { met: false, text: 'No alert: the total moved −$40 since you saved it, not the $100 drop you asked for' }, 'a smaller drop is not the drop asked for');
  assert.deepEqual(watchMet(rule, 130000, 130000), { met: false, text: 'No alert: the total is unchanged since you saved it, not the $100 drop you asked for' });
  assert.deepEqual(watchMet(rule, 130050, 118000), { met: true, text: 'The total dropped $120.50 since you saved it: $1,180 now' }, 'cents are shown when there are any');
});

test('watchMet: "any drop" is met by any cheaper price, never by the same or a higher one', () => {
  const rule = { kind: 'any-drop' };
  assert.deepEqual(watchMet(rule, 130000, 129900), { met: true, text: 'The total dropped $1 since you saved it: $1,299 now' });
  assert.deepEqual(watchMet(rule, 130000, 110000), { met: true, text: 'The total dropped $200 since you saved it: $1,100 now' });
  assert.deepEqual(watchMet(rule, 130000, 130000), { met: false, text: 'No alert: the total is unchanged since you saved it, so the same trip is not cheaper' });
  assert.deepEqual(watchMet(rule, 130000, 131200), { met: false, text: 'No alert: the total moved +$12 since you saved it, so the same trip is not cheaper' });
});

test('watchMet: "at or under" is met at or under the line, and says the total against the line either way', () => {
  const rule = { kind: 'under', amount: 120000 };
  assert.deepEqual(watchMet(rule, 130000, 115000), { met: true, text: 'Now $1,150, under your $1,200' });
  assert.deepEqual(watchMet(rule, 130000, 120000), { met: true, text: 'Now $1,200, at your $1,200' });
  assert.deepEqual(watchMet(rule, 130000, 131000), { met: false, text: 'No alert: the total is $1,310, above your $1,200' });
  assert.deepEqual(watchMet(rule, 110000, 120001), { met: false, text: 'No alert: the total is $1,200.01, above your $1,200' }, 'one cent over is over');
  assert.deepEqual(watchMet(rule, 130000, null), { met: false, text: 'No alert: this trip could not be priced.' });
  assert.throws(() => watchMet({ kind: 'magic' }, 1, 1), e => e.code === 'invalid_watch');
});

test('no watch sentence carries a pressure word, and no alert is ever reported for a rule that is not met', () => {
  const rules = [{ kind: 'drop', amount: 10000 }, { kind: 'any-drop' }, { kind: 'under', amount: 120000 }];
  for (const rule of rules) {
    for (const now of [100000, 115000, 119999, 120000, 120001, 126000, 130000, 131200, 150000]) {
      const r = watchMet(rule, 130000, now);
      assert.ok(!PRESSURE.test(r.text), `${rule.kind} ${now}: ${r.text}`);
      assert.ok(!PRESSURE.test(ruleText(rule)));
      const expected = rule.kind === 'under' ? now <= rule.amount : rule.kind === 'any-drop' ? now < 130000 : 130000 - now >= rule.amount;
      assert.equal(r.met, expected, `${rule.kind} at ${now}`);
      assert.equal(/^No alert/.test(r.text), !r.met, `${rule.kind} at ${now}: the sentence matches the verdict`);
    }
  }
});

test('a signed-up traveler watches a trip under each rule through the route; My Trips shows the rule and no pill until it is met', async t => {
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  await signUp(c, 'ada@example.com');
  const trip = await firstTrip(app, c);
  const dollars = Math.round(trip.total / 100);
  const underLine = dollars - 100; // below today's total, so the rule is not met at save time

  // The trip page offers the rule form beside the Save button, with no script needed.
  const page = await c.req(`${trip.tripPath}?${trip.cx}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<select id="watch-rule" name="rule"><option value="drop">Drops \$100 or more<\/option><option value="any-drop">Any drop<\/option><option value="under">At or under \$<\/option><\/select>/);
  assert.match(page.text, /<input type="text" name="amount" inputmode="numeric"/);
  assert.match(page.text, /<input type="hidden" name="kind" value="watch">/);
  assert.match(page.text, /name="kind" value="saved"[^>]*>.*Save trip/);
  assert.ok(!/\sstyle="/.test(page.text) && !/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(page.text), 'no inline style or script');

  // Each rule kind, as the form or any client would post it: dollars as typed, turned into cents.
  const post = form => c.req(`${trip.tripPath}/save?${trip.cx}`, { method: 'POST', form });
  assert.equal((await post({ kind: 'watch', rule: 'drop', amount: '50' })).status, 303);
  assert.equal((await post({ kind: 'watch', rule: 'any-drop' })).status, 303);
  assert.equal((await post({ kind: 'watch', rule: 'under', amount: `${underLine.toLocaleString('en-US')}` })).status, 303, 'a typed thousands separator is fine');
  assert.equal((await post({ kind: 'watch', rule: 'drop' })).status, 303, 'the drop option with the amount box left blank is the $100 the option names');
  assert.equal((await post({ kind: 'watch' })).status, 303, 'no rule at all (the older form) is the $100 drop');
  assert.equal((await post({ kind: 'saved', rule: 'under', amount: '5' })).status, 303, 'a saved trip ignores the rule fields');

  // Invalid rules and amounts are a 422, never a guess.
  for (const form of [
    { kind: 'watch', rule: 'magic' }, { kind: 'watch', rule: 'under' }, { kind: 'watch', rule: 'under', amount: '' }, { kind: 'watch', rule: 'under', amount: '0' },
    { kind: 'watch', rule: 'under', amount: '-5' }, { kind: 'watch', rule: 'under', amount: 'abc' }, { kind: 'watch', rule: 'drop', amount: '12.345' }, { kind: 'watch', rule: 'drop', amount: '0' },
    [['kind', 'watch'], ['rule', 'drop'], ['amount', '50'], ['amount', '60']], // a repeated field is not an amount, and never the default
  ]) {
    const r = await post(form);
    assert.equal(r.status, 422, JSON.stringify(form));
    assert.match(r.text, /watch|amount|rule/i);
  }

  // The records: every watch carries its rule as cents; the saved trip carries none.
  const { userId } = await app.store.getRecord('user_email', 'ada@example.com');
  const user = { id: userId };
  const watches = await app.tripService.listSaved(user, 'watch');
  assert.equal(watches.length, 5);
  const byText = Object.fromEntries(watches.map(w => [w.ruleText, w]));
  assert.deepEqual(byText['Alert when the total drops $50 or more'].rule, { kind: 'drop', amount: 5000 });
  assert.deepEqual(byText['Alert when the same trip gets cheaper'].rule, { kind: 'any-drop' });
  assert.deepEqual(byText[`Alert when the total is at or under $${underLine.toLocaleString('en-US')}`].rule, { kind: 'under', amount: underLine * 100 });
  assert.equal(watches.filter(w => w.ruleText === 'Alert when the total drops $100 or more').length, 2);
  for (const w of watches) {
    assert.equal(w.kind, 'watch');
    assert.equal(w.priceAtSave, trip.total);
    assert.equal(w.now, trip.total, 'priced again, unchanged in the demo inventory');
    assert.equal(w.alert.met, false, w.ruleText);
    assert.match(w.alert.text, /^No alert: /);
    assert.ok(!PRESSURE.test(w.alert.text));
  }
  assert.equal(byText['Alert when the total drops $50 or more'].alert.text, 'No alert: the total is unchanged since you saved it, not the $50 drop you asked for');
  assert.equal(byText[`Alert when the total is at or under $${underLine.toLocaleString('en-US')}`].alert.text, `No alert: the total is ${money(trip.total)}, above your $${underLine.toLocaleString('en-US')}`);
  const saved = await app.tripService.listSaved(user, 'saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'saved');
  assert.ok(!('rule' in saved[0]) && !('ruleText' in saved[0]) && !('alert' in saved[0]), 'a saved trip has no rule and no alert');
  const stored = await app.store.listRecords('saved', { userId, limit: 10 });
  assert.equal(stored[0].rule, undefined);

  // My Trips: the rule text and the honest line on every watch row, and no "Alert" pill anywhere.
  const mine = await c.req('/my-trips');
  assert.equal(mine.status, 200);
  assert.match(mine.text, /Watching price/);
  assert.match(mine.text, /Alert when the total drops \$50 or more\./);
  assert.match(mine.text, /Alert when the same trip gets cheaper\./);
  assert.match(mine.text, new RegExp(`Alert when the total is at or under \\$${underLine.toLocaleString('en-US')}\\.`));
  assert.match(mine.text, /Alert when the total drops \$100 or more\./);
  assert.match(mine.text, /No alert: the total is unchanged since you saved it, not the \$50 drop you asked for\./);
  assert.match(mine.text, /No alert: the total is unchanged since you saved it, so the same trip is not cheaper\./);
  assert.ok(!mine.text.includes(ALERT_PILL), 'no pill while no rule is met');
  assert.ok(!mine.text.includes('is-alert'), 'no alert class while no rule is met');
  assert.equal((mine.text.match(/action="\/my-trips\/remove"/g) || []).length, 6, 'every saved trip and watch keeps its Remove form');
  assert.ok(!/\sstyle="/.test(mine.text) && !/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(mine.text), 'no inline style or script');
  assert.ok(!PRESSURE.test(mine.text));

  // Once a watch exists the trip page shows that, with no second rule form.
  const again = await c.req(`${trip.tripPath}?${trip.cx}`);
  assert.match(again.text, /<button class="btn btn-ghost" type="button" disabled>.*Watching price<\/button>/);
  assert.ok(!again.text.includes('id="watch-rule"'));
});

test('the "Alert" pill appears only when the rule is met, with the exact amounts; a departed or unpriceable trip never alerts', async t => {
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  await signUp(c, 'grace@example.com');
  const trip = await firstTrip(app, c);
  const { userId } = await app.store.getRecord('user_email', 'grace@example.com');
  const user = { id: userId };
  const svc = app.tripService;

  // The agent's way in: watchTrip returns the record with its rule in words.
  const rec = await svc.watchTrip(user, trip.token, { budget: 150000, rule: { kind: 'drop', amount: 5000 } });
  assert.equal(rec.kind, 'watch');
  assert.deepEqual(rec.rule, { kind: 'drop', amount: 5000 });
  assert.equal(rec.ruleText, 'Alert when the total drops $50 or more');
  assert.equal(rec.budget, 150000);
  assert.equal(rec.priceAtSave, trip.total);
  assert.match(rec.id, /^wch/);
  const plain = await svc.watchTrip(user, trip.token, {});
  assert.deepEqual(plain.rule, { kind: 'drop', amount: 10000 });
  assert.equal(plain.ruleText, 'Alert when the total drops $100 or more');
  await assert.rejects(svc.watchTrip(user, trip.token, { rule: { kind: 'under', amount: 0 } }), e => e.code === 'invalid_watch' && e.status === 422);
  await assert.rejects(svc.saveTrip(user, trip.token, { kind: 'bookmark' }), e => e.code === 'invalid_watch' && e.status === 422);
  const savedRec = await svc.saveTrip(user, trip.token, { kind: 'saved', rule: { kind: 'under', amount: 1 } });
  assert.equal(savedRec.rule, undefined, 'a saved trip carries no rule even when one is passed');

  // The price has not moved, so nothing alerts yet.
  let rows = await svc.listSaved(user, 'watch');
  assert.ok(rows.every(r => r.alert && r.alert.met === false));
  assert.ok(!(await c.req('/my-trips')).text.includes(ALERT_PILL));

  // The drop rule is met once the saved price stands $200 above today's: the pill and the sentence appear.
  const storedRec = (await app.store.listRecords('watch', { userId, limit: 10 })).find(r => r.id === rec.id);
  await app.store.putRecord('watch', rec.id, { ...storedRec, priceAtSave: trip.total + 20000 }, { userId });
  rows = await svc.listSaved(user, 'watch');
  const dropped = rows.find(r => r.id === rec.id);
  const nowText = money(trip.total);
  assert.deepEqual(dropped.alert, { met: true, text: `The total dropped $200 since you saved it: ${nowText} now` });
  assert.equal(dropped.change, -20000);
  const other = rows.find(r => r.id === plain.id);
  assert.equal(other.alert.met, false, 'the $100 rule on the unchanged watch is still not met');
  let mine = await c.req('/my-trips');
  assert.equal((mine.text.match(new RegExp(ALERT_PILL.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&'), 'g')) || []).length, 1, 'exactly one pill, on the watch whose rule is met');
  assert.match(mine.text, /<li class="tb-mytrip is-alert">/);
  assert.match(mine.text, new RegExp(`The total dropped \\$200 since you saved it: ${nowText.replace(/[$.]/g, '\\$&')} now\\.`));

  // An "at or under" line above today's total is met at once and says so; one below it is not.
  const above = Math.round(trip.total / 100) + 50, below = Math.round(trip.total / 100) - 50;
  const metUnder = await svc.watchTrip(user, trip.token, { rule: { kind: 'under', amount: above * 100 } });
  const notUnder = await svc.watchTrip(user, trip.token, { rule: { kind: 'under', amount: below * 100 } });
  rows = await svc.listSaved(user, 'watch');
  assert.deepEqual(rows.find(r => r.id === metUnder.id).alert, { met: true, text: `Now ${nowText}, under your $${above.toLocaleString('en-US')}` });
  assert.deepEqual(rows.find(r => r.id === notUnder.id).alert, { met: false, text: `No alert: the total is ${nowText}, above your $${below.toLocaleString('en-US')}` });
  mine = await c.req('/my-trips');
  assert.equal((mine.text.match(/class="tb-mytrip is-alert"/g) || []).length, 2);

  // A watch on a trip that can no longer be priced keeps trip and alert null, and the row says so without a pill.
  const spec = decodeSpec(trip.token);
  const goneToken = encodeSpec({ ...spec, hotel: 'no-such-hotel' });
  await app.store.putRecord('watch', 'wch_gone', { id: 'wch_gone', kind: 'watch', token: goneToken, budget: null, priceAtSave: 99900, title: 'Gone trip', savedAt: new Date().toISOString(), rule: { kind: 'any-drop' } }, { userId });
  // A watch saved before rules existed carries none: it reads as the $100 drop. Its dates have passed, so it cannot alert.
  const pastToken = encodeSpec({ ...spec, depart: addDays(today(), -10) });
  await app.store.putRecord('watch', 'wch_past', { id: 'wch_past', kind: 'watch', token: pastToken, budget: null, priceAtSave: 999900, title: 'Past trip', savedAt: new Date().toISOString() }, { userId });
  rows = await svc.listSaved(user, 'watch');
  const gone = rows.find(r => r.id === 'wch_gone');
  assert.equal(gone.trip, null); assert.equal(gone.alert, null); assert.equal(gone.ruleText, 'Alert when the same trip gets cheaper');
  const past = rows.find(r => r.id === 'wch_past');
  assert.equal(past.departed, true);
  assert.deepEqual(past.rule, { kind: 'drop', amount: 10000 });
  assert.ok(past.alert === null || past.alert.met === false, 'a trip whose dates passed never alerts');
  if (past.alert) assert.equal(past.alert.text, 'No alert: this trip’s dates have passed');
  mine = await c.req('/my-trips');
  assert.match(mine.text, /Gone trip/);
  assert.match(mine.text, /Alert when the same trip gets cheaper\. No alert: the trip can no longer be priced\./);
  assert.equal((mine.text.match(/class="tb-mytrip is-alert"/g) || []).length, 2, 'the gone and the departed watches add no pill');
  assert.ok(!PRESSURE.test(mine.text));
});
