// The Trip Challenge: the trip to beat is never guessed, the fight is like for like, the verdict is one
// of four honest states, and the platform is allowed to lose.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS } = require('../server/trips/pricing');
const { addDays, today } = require('../server/lib/dates');
const challenge = require('../server/trips/challenge');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const maps = inv.maps;
const DEPART = addDays(today(), 60);
const PARIS = { dest: 'paris', from: 'nyc', depart: DEPART, nights: '6', who: 'couple', n: '2', total: '3,200', flight: 'stops', stars: '3', meals: 'none', bags: 'carry-on', transfer: 'no', cancel: 'nonrefundable', taxes: 'included' };
const CANCUN = { dest: 'cancun', from: 'NYC', depart: DEPART, nights: '5', who: 'couple', n: '2', total: '1860', flight: 'nonstop', stars: '4', meals: 'all-inclusive', bags: 'checked', transfer: 'no', cancel: 'nonrefundable', taxes: 'included' };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const run = (raw, mode) => {
  const { challenger, missing } = challenge.parseChallenger(raw, { maps });
  assert.deepEqual(missing, []);
  return challenge.runChallenge(inv, challenger, DEFAULT_SETTINGS, { mode });
};

test('the trip to beat: what is not given stays unknown, never guessed; the essentials are required', () => {
  const { challenger: ch, missing } = challenge.parseChallenger({ dest: 'cancun', from: 'nyc', nights: '5', total: '$1,860' }, { maps });
  assert.deepEqual(missing, []);
  assert.equal(ch.total, 186000);
  assert.equal(ch.origin, 'NYC');
  assert.equal(ch.depart, null);
  assert.equal(ch.who, 'couple'); assert.equal(ch.travelers, 2);
  for (const k of ['flight', 'meals', 'bags', 'transfer', 'cancel', 'taxes']) assert.equal(ch[k], challenge.UNKNOWN, k);
  assert.equal(ch.stars, null);
  assert.deepEqual(challenge.unknownsOf(ch), ['dates', 'flight', 'stars', 'meals', 'bags', 'transfer', 'cancel', 'taxes']);
  // Garbage is not quietly turned into a value.
  const bad = challenge.parseChallenger({ dest: 'atlantis', from: 'zzz', nights: '99', total: '12', flight: 'teleport', stars: '7', lock: ['dest', 'bogus'] }, { maps });
  assert.deepEqual(bad.missing, ['dest', 'from', 'nights', 'total']);
  assert.equal(bad.challenger.flight, challenge.UNKNOWN); assert.equal(bad.challenger.stars, null);
  assert.deepEqual(bad.challenger.locks, ['dest']);
  // A date outside the bookable window is treated as unknown rather than silently moved.
  const past = challenge.parseChallenger({ ...CANCUN, depart: '2020-01-01' }, { maps }).challenger;
  assert.equal(past.depart, null);
  // The URL round-trips without losing anything the traveler typed, locks included.
  const p = new URLSearchParams(challenge.challengerParams({ ...ch, locks: ['nights', 'dest'] }));
  assert.deepEqual(p.getAll('lock'), ['nights', 'dest']);
  assert.equal(p.get('total'), '1860');
  assert.equal(challenge.parseChallenger(Object.fromEntries(p), { maps }).challenger.total, 186000);
});

test('a fair fight: our version carries everything theirs is known to include, and locks stick', () => {
  const ch = challenge.parseChallenger(CANCUN, { maps }).challenger;
  const floor = challenge.floorOf(ch);
  assert.equal(floor.nonstop, true); assert.equal(floor.stars, 4); assert.equal(floor.meals, 2); assert.equal(floor.bags, 2);
  const pkgs = challenge.comparablePackages(inv, ch, DEFAULT_SETTINGS, { dests: [maps.getDestination('cancun')], nightsList: [5] });
  assert.ok(pkgs.length > 0);
  for (const t of pkgs) {
    assert.equal(t.flight.stops, 0);
    assert.ok(t.hotel.stars >= 4);
    assert.equal(t.hotel.features.allInclusive, true);
    assert.ok(t.flight.checkedBagIncluded || t.spec.bags, 'a checked bag per traveler');
    assert.equal(t.spec.nights, 5);
    assert.equal(t.spec.depart, DEPART);
  }
  // Unknown attributes impose nothing: cheaper, lesser versions are allowed into the comparison.
  const loose = challenge.parseChallenger({ ...CANCUN, flight: 'unknown', stars: 'unknown', meals: 'unknown', bags: 'unknown' }, { maps }).challenger;
  const loosePkgs = challenge.comparablePackages(inv, loose, DEFAULT_SETTINGS, { dests: [maps.getDestination('cancun')], nightsList: [5] });
  assert.ok(loosePkgs.length > pkgs.length);
  assert.ok(Math.min(...loosePkgs.map(t => t.total)) < Math.min(...pkgs.map(t => t.total)));
  // A transfer floor and a refundable floor are honored too.
  const strict = challenge.parseChallenger({ ...PARIS, transfer: 'yes', cancel: 'refundable' }, { maps }).challenger;
  for (const t of challenge.comparablePackages(inv, strict, DEFAULT_SETTINGS, { dests: [maps.getDestination('paris')], nightsList: [6] })) {
    assert.ok(t.transfer, 'transfer included'); assert.ok(t.flight.refundable && t.hotel.refundable, 'refundable fare and rate');
  }
});

test('four verdicts only: we beat it, a different trade-off, your deal wins, we need more information', () => {
  // Same trip for less: a real cheaper complete price with nothing worse on what they told us.
  const less = run(PARIS, 'less');
  assert.equal(less.verdict.state, 'beat');
  assert.ok(less.ours.total < less.challenger.total);
  assert.deepEqual(less.verdict.downs, []);
  assert.equal(less.receipt.saving, less.challenger.total - less.ours.total);
  assert.ok(less.receipt.kept.includes('nights') && less.receipt.kept.includes('dest') && less.receipt.kept.includes('dates'));
  // Better trip, same money: the total stays at or under theirs and at least one row is really better.
  const better = run(PARIS, 'better');
  assert.equal(better.verdict.state, 'beat');
  assert.ok(better.ours.total <= better.challenger.total);
  assert.ok(better.verdict.ups.length >= 1);
  assert.equal(better.ours.spec.nights, 6);
  // More vacation: extra nights, same money or less, everything else kept.
  const more = run(PARIS, 'more');
  assert.ok(more.ours.spec.nights > 6 && more.ours.total <= more.challenger.total);
  assert.ok(more.verdict.ups.includes('nights'));
  // Surprise me changes the place, so it can only ever be a trade-off, never a win we call.
  const surprise = run(PARIS, 'surprise');
  assert.notEqual(surprise.ours.dest.id, 'paris');
  assert.equal(surprise.verdict.state, 'tradeoff');
  assert.ok(surprise.verdict.different.includes('dest'));
  // Your deal wins: we cannot keep everything they listed for their money, and we say so.
  const keep = run(CANCUN, 'less');
  assert.equal(keep.verdict.state, 'keep');
  assert.equal(keep.verdict.reason, 'dearer');
  assert.ok(keep.cheapest.total > keep.challenger.total);
  assert.equal(keep.receipt.saving, 0);
  for (const m of ['better', 'more', 'easier', 'surprise']) { const o = run(CANCUN, m); assert.equal(o.verdict.state, 'keep', m); assert.equal(o.ours, null, m); }
  // We need more information: with unknowns no verdict claims a win, even when ours is far cheaper.
  const info = run({ dest: 'paris', from: 'nyc', nights: '6', total: '3200' }, 'less');
  assert.equal(info.verdict.state, 'info');
  assert.ok(info.ours && info.ours.total < info.challenger.total);
  assert.equal(info.receipt.saving, 0);
  assert.ok(info.verdict.unknowns.includes('dates'));
  // The $100 more: an improvement with zero trade-offs within $100 of their price, else keep the $100.
  if (less.plus) {
    assert.ok(less.plus.trip.total <= less.challenger.total + challenge.PLUS);
    assert.ok(less.plus.changes.improvements.length >= 1 && less.plus.changes.tradeoffs.length === 0);
  }
  assert.equal(keep.plus, null);
  // A locked destination keeps "surprise me" from changing it.
  const locked = run({ ...PARIS, lock: 'dest' }, 'surprise');
  assert.equal(locked.modes.surprise, null);
  // A mode that finds nothing within their money falls back to the plain cheaper version, said as such.
  const dearNights = challenge.parseChallenger({ ...PARIS, lock: 'nights' }, { maps }).challenger;
  const moreLocked = challenge.runChallenge(inv, dearNights, DEFAULT_SETTINGS, { mode: 'more' });
  assert.equal(moreLocked.modes.more, null);
  assert.equal(moreLocked.fallback, 'less');
  assert.equal(moreLocked.verdict.state, 'beat');
  assert.throws(() => challenge.runChallenge(inv, dearNights, DEFAULT_SETTINGS, { mode: 'magic' }), /beat it/);
});

test('challenge pages: unknowns marked, no win claimed without the facts, keep my deal on a loss', async t => {
  const app = await startApp({});
  t.after(app.close);
  const get = async path => { const r = await fetch(app.base + path, { redirect: 'manual' }); return { status: r.status, html: await r.text() }; };
  const q = o => new URLSearchParams(o).toString();

  const form = await get('/challenge');
  assert.equal(form.status, 200);
  assert.match(form.html, /Can we build a better vacation\?/);
  assert.ok((form.html.match(/value="unknown" checked/g) || []).length >= 6, 'every attribute defaults to unknown');
  assert.match(form.html, /name="hotel"/);

  const missing = await get('/challenge/review?dest=cancun');
  assert.equal(missing.status, 200);
  assert.match(text(missing.html), /we need where you’re leaving from, the number of nights and their total price/);

  const review = await get(`/challenge/review?${q({ dest: 'cancun', from: 'nyc', nights: '5', total: '1860' })}`);
  assert.equal(review.status, 200);
  const rv = text(review.html);
  assert.match(rv, /The trip to beat/);
  assert.match(rv, /8 items unknown/);
  assert.ok((review.html.match(/class="is-unknown"/g) || []).length === 8);
  assert.match(review.html, /name="mode" value="surprise"/);
  assert.doesNotMatch(rv, /You keep \$|We beat it/);

  const info = await get(`/challenge/result?${q({ dest: 'cancun', from: 'nyc', nights: '5', total: '1860', mode: 'less' })}`);
  const iv = text(info.html);
  assert.match(iv, /We need more information\./);
  assert.doesNotMatch(iv, /We beat it|You keep \$|saved you/);
  assert.match(iv, /Add what you know/);

  const beat = await get(`/challenge/result?${q({ ...PARIS, mode: 'less' })}`);
  const bv = text(beat.html);
  assert.match(bv, /We beat it\./);
  assert.match(bv, /You keep \$/);
  assert.match(bv, /Take the challenger/);
  assert.match(bv, /Keep my deal/);
  assert.match(bv, /Why did we win\?/);
  assert.match(beat.html, /href="\/trip\/[^"]+\?b=3200/);

  const keep = await get(`/challenge/result?${q({ ...CANCUN, mode: 'better' })}`);
  const kv = text(keep.html);
  assert.match(kv, /Your deal wins\./);
  assert.match(kv, /Keep my deal/);
  assert.doesNotMatch(kv, /Take the challenger|You keep \$/);
  assert.match(kv, /Why is their deal better\?/);
  assert.match(kv, /we won’t invent a reason/);

  const surprise = await get(`/challenge/result?${q({ ...PARIS, mode: 'surprise' })}`);
  assert.match(text(surprise.html), /We found a different trade-off\./);
  // Surprise me with the destination locked is answered as same trip for less, not a loss.
  const locked = await get(`/challenge/result?${q({ ...PARIS, mode: 'surprise', lock: 'dest' })}`);
  assert.match(text(locked.html), /Same trip for less .* We beat it\./);

  const home = await get('/ai-travel-agent');
  assert.match(home.html, /action="\/challenge"/);
  assert.match(text(home.html), /Challenge us/);
  // The older beat-my-quote entry still works for anyone holding the link.
  const old = await get(`/dream?${q({ dest: 'cancun', b: '1860', from: 'NYC', nights: '5', beat: '1', who: 'couple', n: '2' })}`);
  assert.equal(old.status, 200);
  // No inline scripts or styles on the new pages.
  for (const page of [form, review, info, beat, keep]) { assert.doesNotMatch(page.html, /<script>|<script [^>]*>[^<]/); assert.doesNotMatch(page.html, / style="/); }
});
