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

// Dollars as typed ("1,500", "$1,500.50") to cents; anything unreadable is NaN, which the service
// refuses with its own sentence, so the customer sees why instead of a silently changed number.
function dollarsToCents(v) {
  const s = str(v, 20).replace(/[,$\s]/g, '');
  return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN;
}

// The form's fields as the service expects them. Blank selects mean "no rule"; the beat-saved kind
// applies only when a saved trip is chosen (the form says so beside the box).
function toInput(body) {
  const savedToken = str(body.saved, 400) || null;
  const notify = [].concat(body.notify || []).filter(k => typeof k === 'string').map(k => k.slice(0, 20)).filter(k => k !== 'beat-saved' || savedToken);
  const [flightStops, flightRule] = NONSTOP[str(body.nonstop, 10)] || [null, null];
  const threshold = str(body.threshold, 10);
  return {
    budget: dollarsToCents(body.budget),
    origin: str(body.from, 10).toUpperCase(),
    travelers: str(body.travelers, 3) || undefined,
    who: str(body.who, 10),
    dateMode: str(body.when, 10) === 'flexible' ? 'flexible' : 'anytime',
    month: str(body.month, 7),
    minNights: str(body.nights, 3),
    maxNights: str(body.maxNights, 3) || undefined,
    style: str(body.style, 20) || 'surprise',
    rules: {
      flightStops, flightRule,
      minStars: str(body.stars, 2) || null, refundable: body.refundable ? true : null,
      meals: str(body.meals, 20) || null, bags: str(body.bags, 10) || null,
    },
    savedToken,
    notify,
    threshold: threshold === 'custom' ? dollarsToCents(body.thresholdCustom) : threshold === 'recommend' || !threshold ? 'recommend' : threshold,
    savingsLevel: str(body.savingsLevel, 12) || 'balanced',
  };
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
    hunt, error, originCity: originCity(hunt.origin), destName, rules: hunter.ruleLines(hunt, { maps }),
    monitoring: hunts.monitoringText(), acceptance: ACCEPTANCE, thresholds: hunter.THRESHOLDS,
  });

  r.get('/hunts', requireUser, async (req, res, next) => {
    try {
      send(res, huntsListView(ctx, { hunts: await hunts.list(req.user), user: req.user, monitoring: hunts.monitoringText(), destName }));
    } catch (e) { next(e); }
  });

  r.get('/hunts/new', requireUser, async (req, res, next) => {
    try { await formPage(req, res, { values: req.query }); } catch (e) { next(e); }
  });

  r.post('/hunts', writeLimiter, sameOrigin, form, requireUser, compute, async (req, res, next) => {
    try {
      const input = toInput(req.body);
      if (!input.notify.length) throw new AppError('invalid_hunt', 'Tick at least one kind of win worth telling you about.', 422);
      const hunt = await hunts.create(req.user, input);
      res.redirect(303, `/hunts/${hunt.id}`);
    } catch (e) {
      // The form comes back as sent: an unticked set of wins stays unticked (the message says why).
      if (e instanceof AppError && e.status === 422) return formPage(req, res, { values: { ...req.body, notify: [].concat(req.body.notify || []) }, error: e.message, status: 422 }).catch(next);
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

module.exports = { huntsRouter, toInput, dollarsToCents, monthsFrom };
