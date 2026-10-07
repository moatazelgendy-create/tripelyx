// The AI Savings Hunter's pages: the list of a customer's hunts, the form that starts one, the hunt
// page (the persistent card, the opportunities with their receipts, the run log, what the hunt
// learned) and the one route every answer goes through. Every number a page shows is a stored or
// priced fact from the hunt record (server/trips/hunts.js) or arithmetic on two of them; the pages
// never search on their own, so nothing here implies a check that did not happen.
const express = require('express');
const { AppError } = require('../lib/errors');
const { str } = require('../lib/validate');
const hunter = require('../trips/hunter');
const { ACCEPTANCE } = require('../trips/hunts');
const { requireUser } = require('./trips');
const { huntsListView, huntFormView, huntView } = require('../views/trips/hunts');

const send = (res, view) => res.type('html').send(String(view));
const NONSTOP = { hard: ['nonstop', 'hard'], preferred: ['nonstop', 'preferred'] };
// The form's fields in the customer's words, for the sentence that refuses a field sent twice.
const FIELD_WORDS = { budget: 'the limit', from: 'the departure city', travelers: 'the travelers', who: 'who is going', when: 'the dates', month: 'the month', nights: 'the minimum nights', maxNights: 'the maximum nights', style: 'the style', nonstop: 'the flights rule', stars: 'the hotel stars', refundable: 'the cancellation rule', meals: 'the meals rule', bags: 'the bags rule', threshold: 'the saving worth an interruption', thresholdCustom: 'the saving worth an interruption', savingsLevel: 'the savings level', saved: 'the saved trip' };

// Dollars as typed ("1,500", "$1,500.50") to cents; anything unreadable, a value that is not one
// typed string included, is NaN, which the service refuses with its own sentence, so the customer
// sees why instead of a silently changed number.
function dollarsToCents(v) {
  const s = typeof v === 'string' ? v.replace(/[,$\s]/g, '') : '';
  return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN;
}

// One value per field, as typed. A field the browser sent twice (two radios with one name, a
// crafted post) is unreadable: it is refused by name, never joined into a number the customer did
// not type ("1" and "500" are not $1,500) and never quietly the default rule.
function one(body, key, max) {
  const v = body[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new AppError('invalid_hunt', `The form sent ${FIELD_WORDS[key] || key} more than once; send it again with one value.`, 422);
  return str(v, max);
}

// The form's fields as the service expects them. Blank selects mean "no rule"; the beat-saved kind
// applies only when a saved trip is chosen (the form says so beside the box). A value the form does
// not offer (a flights rule other than hard or preferred, a cancellation answer that is not yes or
// no) is handed to the service as sent, so it is refused in words rather than read as "no rule".
function toInput(body) {
  const savedToken = one(body, 'saved', 400) || null;
  const notify = [].concat(body.notify || []).filter(k => typeof k === 'string').map(k => k.slice(0, 20)).filter(k => k !== 'beat-saved' || savedToken);
  const nonstop = one(body, 'nonstop', 10);
  const [flightStops, flightRule] = nonstop ? NONSTOP[nonstop] || [nonstop, null] : [null, null];
  const threshold = one(body, 'threshold', 10);
  return {
    budget: dollarsToCents(one(body, 'budget', 20)),
    origin: one(body, 'from', 10).toUpperCase(),
    travelers: one(body, 'travelers', 3) || undefined,
    who: one(body, 'who', 10),
    dateMode: one(body, 'when', 10) === 'flexible' ? 'flexible' : 'anytime',
    month: one(body, 'month', 7),
    minNights: one(body, 'nights', 3),
    maxNights: one(body, 'maxNights', 3) || undefined,
    style: one(body, 'style', 20) || 'surprise',
    rules: {
      flightStops, flightRule,
      minStars: one(body, 'stars', 2) || null, refundable: one(body, 'refundable', 10) || null,
      meals: one(body, 'meals', 20) || null, bags: one(body, 'bags', 10) || null,
    },
    savedToken,
    notify,
    threshold: threshold === 'custom' ? dollarsToCents(one(body, 'thresholdCustom', 20)) : threshold === 'recommend' || !threshold ? 'recommend' : threshold,
    savingsLevel: one(body, 'savingsLevel', 12) || 'balanced',
  };
}

// The form prefilled from a query string or from a refused post, as sent: a field sent more than
// once comes back blank (no value was read from it), the wins come back as ticked.
function prefill(src) {
  return Object.fromEntries(Object.entries(src || {}).map(([k, v]) => [k, k === 'notify' ? [].concat(v).filter(x => typeof x === 'string') : typeof v === 'string' ? v : '']));
}

// The next twelve months from now, for the window select.
function monthsFrom(now) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < 12; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function huntsRouter(ctx, { writeLimiter, computeLimiter, sameOrigin }) {
  const { tripService: svc, hunts } = ctx;
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb' });
  const compute = computeLimiter || ((req, res, next) => next());
  const maps = svc.inv.maps;
  const destName = id => { const d = maps.getDestination(id); return d ? d.name : id; };
  const originCity = id => { const o = maps.getOrigin(id); return o ? o.city : id; };

  r.use('/hunts', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const formPage = async (req, res, { values, error = null, status = 200 }) => {
    const saved = await svc.listSaved(req.user, 'saved');
    send(res.status(status), huntFormView(ctx, {
      values, error, user: req.user, origins: maps.listOrigins(), months: monthsFrom(svc.now()),
      saved: saved.filter(s => s.trip && !s.departed), monitoring: hunts.monitoringText(),
    }));
  };
  const huntPage = (hunt, { error = null } = {}) => huntView(ctx, {
    hunt, error, originCity: originCity(hunt.origin), destName, rules: hunter.ruleLines(hunts.recall(hunt), { maps }),
    monitoring: hunts.monitoringText(), acceptance: ACCEPTANCE, thresholds: hunter.THRESHOLDS,
  });

  r.get('/hunts', requireUser, async (req, res, next) => {
    try {
      send(res, huntsListView(ctx, { hunts: await hunts.list(req.user), user: req.user, monitoring: hunts.monitoringText(), destName }));
    } catch (e) { next(e); }
  });

  r.get('/hunts/new', requireUser, async (req, res, next) => {
    try { await formPage(req, res, { values: prefill(req.query) }); } catch (e) { next(e); }
  });

  r.post('/hunts', writeLimiter, sameOrigin, form, requireUser, compute, async (req, res, next) => {
    try {
      const input = toInput(req.body);
      if (!input.notify.length) throw new AppError('invalid_hunt', 'Tick at least one kind of win worth telling you about.', 422);
      const hunt = await hunts.create(req.user, input);
      res.redirect(303, `/hunts/${hunt.id}`);
    } catch (e) {
      // The form comes back as sent: an unticked set of wins stays unticked (the message says why).
      if (e instanceof AppError && e.status === 422) return formPage(req, res, { values: { ...prefill(req.body), notify: [].concat(req.body.notify || []).filter(k => typeof k === 'string') }, error: e.message, status: 422 }).catch(next);
      next(e);
    }
  });

  // Opening a hunt re-checks it when its last check is old (the service decides, and says so in the
  // run log); otherwise the stored facts are shown as they are.
  r.get('/hunts/:id', requireUser, compute, async (req, res, next) => {
    try {
      const hunt = await hunts.refresh(req.user, req.params.id);
      send(res, huntPage(hunt));
    } catch (e) { next(e); }
  });

  r.post('/hunts/:id/respond', writeLimiter, sameOrigin, form, requireUser, compute, async (req, res, next) => {
    try {
      const payload = { what: str(req.body.what, 20), reason: str(req.body.reason, 120), opportunityId: str(req.body.opportunityId, 60) };
      await hunts.respond(req.user, req.params.id, str(req.body.action, 20), payload);
      res.redirect(303, `/hunts/${encodeURIComponent(req.params.id)}`);
    } catch (e) {
      // A refused answer ("nonstop is already a hard rule") is said on the hunt page, not lost.
      if (!(e instanceof AppError) || e.status !== 422) return next(e);
      try { send(res.status(422), huntPage(await hunts.get(req.user, req.params.id), { error: e.message })); } catch (e2) { next(e2); }
    }
  });

  return r;
}

module.exports = { huntsRouter, toInput, dollarsToCents, monthsFrom, prefill };
