// Is a flight, a hotel or a whole trip inside a company's travel policy? (plan §E3). Pure: no store, no clock
// (ctx.today is passed in), integer math, inputs never mutated (the tests deep-freeze them), and no access to
// markup, commission or any cost: rows are the allow-listed DTOs of dto.js.
//
// Rules (within when …):
//   flight.cap        totalCents ≤ cap (equal is within)            "Over your $712 limit by $86 (median of these demo fares plus 20%)."
//   flight.cabin      rank(cabin) ≤ rank(maxCabin); a route override's maxCabin wins
//                                                                   "Business class is above your limit (Economy) for flights under 6 hours."
//   flight.advance    daysBetween(today, departure's local date) ≥ minAdvanceDays
//                                                                   "Planned 3 days ahead. Your policy asks for 7."
//   flight.stops      stops ≤ maxStops (when not null)              "1 stop. Your policy allows nonstop only."
//   flight.refundable fare.refundablePercent > 0 (when required)    "Your policy asks for a fare that refunds at least part of the price. Light refunds nothing."
//   flight.carrier    no segment's carrier is blocked; severity block "Sahara Wings isn't used by Acme Inc."
//   hotel.cap         basis total ≤ cap × nights (no per-night rounding); the violation's limit is cap × nights,
//                     its actual the stay's basis total and overCents their difference (stay totals, never
//                     per night); only the text quotes nightly amounts (Math.round(actual / nights), shown a
//                     cent over the cap when rounding would make it read as equal, and the cap)
//                                                                   "$340 a night is over the London limit of $300 (taxes included)."
//   hotel.stars       stars ≤ maxStars                              "5-star hotel. Your policy allows up to 4 stars."
//   hotel.advance     as flights, on checkIn
//   hotel.refundable  cancellation.refundable (free, or partial with freeUntilHours > 0)
//   trip.cap          totalCents ≤ maxTotalCents                    "The trip total is over your $2,500 trip limit by $310."
//   budget            totalCents ≤ remainingCents; severity approval; the period in words is budget.periodLabel
//                                                                   "This trip would use $1,240 of the $900 left in Engineering for Q4 2026."
//   inventory.unavailable  row.available; severity block            "Not available in demo data."
// Status: any block violation → blocked; else with outOfPolicy 'block' any non-budget violation → blocked;
// else any violation → out; else within. A trip takes its worst component, plus trip.cap and budget; a
// budget-only overrun is out, never blocked. Texts use lib/money formatting, no em dash, no PRESSURE words.
//
// Settled details:
// - The basis total of a stay: incl_taxes → totalCents; excl_taxes → totalCents minus its 'tax' lines.
// - A route override applies to a flight row whose first departure and last arrival airports match it (either
//   direction when bothWays). Its cap replaces the band's cap ({mode:'none'} there means no price limit on that
//   route), its maxCabin (when not null) the band's cabin; the band's advance, stops and refundability still apply.
// - An unavailable row has no price: the price rules (flight.cap, hotel.cap) are skipped, the others still run.
// - trip.cap and budget run only when every component is available (the total is unknown otherwise; the trip
//   is blocked anyway).
// - Violations within a component follow RULE_IDS order.
//
// Real suppliers, round 1 (real-suppliers design §8.3): the texts follow where the prices came from, and the
// demo texts above are unchanged. ctx.priceSource (absent: the row's own source, which is 'demo' for every
// demo row) names the search's fares in a cap reason: "median of these test fares plus 20%" for supplier
// test data, "median of the fares in this search plus 20%" for live prices. A row's own source names it in
// inventory.unavailable ("Not available in the supplier's test data."). A supplier fare whose refund terms
// the airline doesn't confirm (source.refundsUnconfirmed) is never said to refund nothing: "…, and Tripelyx
// can't confirm that for Economy Light." A supplier hotel with stars 0 has no star rating: under a maxStars
// limit it needs approval (hotel.stars, actual 0) instead of passing as a 0-star hotel.
const { CABIN_RANK, CABIN_LABELS } = require('../constants');
const { sourceOf, isSource, refundsUnconfirmed } = require('../source');

// lib/money.format builds an Intl.NumberFormat on every call, and evaluate runs for every candidate of a
// search (the 200-candidate ranking budget is 20 ms), so it keeps the formatters money.format would build:
// the same locale and options, so the same text.
const FORMATTERS = new Map();
function format(cents, currency = 'USD') {
  const digits = cents % 100 ? 2 : 0;
  const key = `${currency}|${digits}`;
  if (!FORMATTERS.has(key)) FORMATTERS.set(key, new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits }));
  return FORMATTERS.get(key).format(cents / 100);
}

/** Every rule id a Violation can carry, in display order. */
const RULE_IDS = Object.freeze([
  'flight.cap', 'flight.cabin', 'flight.advance', 'flight.stops', 'flight.refundable', 'flight.carrier',
  'hotel.cap', 'hotel.stars', 'hotel.advance', 'hotel.refundable', 'trip.cap', 'budget', 'inventory.unavailable',
]);

/** Status order for sorting and roll-up: within < out < blocked. */
const STATUS_RANK = Object.freeze({ within: 0, out: 1, blocked: 2 });

const DAY_MS = 86400000;
const RULE_ORDER = Object.freeze(Object.fromEntries(RULE_IDS.map((r, i) => [r, i])));

/** Whole days from date a to date b ('YYYY-MM-DD'), integer. */
function daysBetween(a, b) {
  const x = Date.parse(`${a}T00:00:00Z`), y = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('[business] a date must be YYYY-MM-DD');
  return Math.round((y - x) / DAY_MS);
}

/** Names compared case-insensitively after NFKC ("Türkiye", "TÜRKIYE"). */
const nameKey = s => String(s ?? '').normalize('NFKC').trim().toLowerCase();

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "6 hours", "6 hours 30 minutes", "1 hour". */
function hoursText(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return [h ? plural(h, 'hour') : '', m ? plural(m, 'minute') : ''].filter(Boolean).join(' ');
}

/** Integer tenths of a percent as typed: 200 → "20", 75 → "7.5". */
const pctText = tenths => (tenths % 10 ? `${(tenths - (tenths % 10)) / 10}.${tenths % 10}` : String(tenths / 10));

/** "Business class", "Premium economy", "Economy". */
const cabinName = cabin => (cabin === 'business' ? 'Business class' : CABIN_LABELS[cabin] || String(cabin));

const severityOf = rule => (rule === 'flight.carrier' || rule === 'inventory.unavailable' ? 'block' : 'approval');

function violation(rule, component, limit, actual, text) {
  return { rule, component, severity: severityOf(rule), limit, actual, text };
}

/** The airports a flight row starts and ends at. */
function endpoints(row) {
  const segs = Array.isArray(row.segments) ? row.segments : [];
  return {
    from: segs.length ? segs[0].from.code : null,
    to: segs.length ? segs[segs.length - 1].to.code : null,
  };
}

/** The first route override matching the row, or null. */
function routeOverrideFor(rules, row) {
  const { from, to } = endpoints(row);
  if (!from || !to) return null;
  for (const o of rules.flights.routeOverrides || []) {
    if ((o.from === from && o.to === to) || (o.bothWays && o.from === to && o.to === from)) return o;
  }
  return null;
}

const haulOf = (rules, row) => (row.flyingMinutes >= rules.flights.longHaulMinutes ? 'long' : 'short');
const bandOf = (rules, haul) => (haul === 'long' ? rules.flights.longHaul : rules.flights.shortHaul);

/** A cap in cents given the median (null when the search had too few fares), and how it was reached. */
function capCents(cap, medianCents) {
  switch (cap && cap.mode) {
    case 'fixed': return { cents: cap.amountCents, how: 'fixed' };
    case 'median_pct':
      return medianCents == null ? { cents: cap.fallbackCents, how: 'fallback' }
        : { cents: medianCents + Math.floor((medianCents * cap.pctTenths) / 1000), how: 'median_pct' };
    case 'median_plus':
      return medianCents == null ? { cents: cap.fallbackCents, how: 'fallback' } : { cents: medianCents + cap.amountCents, how: 'median_plus' };
    case 'none': return { cents: null, how: 'none' };
    default: throw new TypeError(`[business] unknown cap mode ${cap && cap.mode}`);
  }
}

/** The search's fares in a cap reason, by price source. */
const FARES = Object.freeze({
  demo: Object.freeze({ median: 'these demo fares', few: 'demo fares' }),
  sandbox: Object.freeze({ median: 'these test fares', few: 'test fares' }),
  live: Object.freeze({ median: 'the fares in this search', few: 'fares' }),
});

/** Where a row's prices came from, for its texts: ctx.priceSource when given, else the row's own. */
const priceSourceOf = (ctx, row) => (ctx && isSource(ctx.priceSource) ? ctx.priceSource : sourceOf(row));

/** Why a flight cap is what it is, for the violation text: "(median of these demo fares plus 20%)". */
function capReason(cap, how, source = 'demo') {
  const fares = FARES[source] || FARES.demo;
  if (how === 'median_pct') return ` (median of ${fares.median} plus ${pctText(cap.pctTenths)}%)`;
  if (how === 'median_plus') return ` (median of ${fares.median} plus ${format(cap.amountCents)})`;
  if (how === 'fallback') return ` (your set limit, as this search has too few ${fares.few} to compare)`;
  return '';
}

/** inventory.unavailable, said for where the row came from. */
const UNAVAILABLE_TEXT = Object.freeze({
  demo: 'Not available in demo data.',
  sandbox: "Not available in the supplier's test data.",
  live: 'No longer available from the supplier.',
});
const unavailableText = row => UNAVAILABLE_TEXT[sourceOf(row)] || UNAVAILABLE_TEXT.demo;

/**
 * The price limit for one flight row: the first matching route override (from/to, or reversed when
 * bothWays), else the band for its haul (flyingMinutes ≥ longHaulMinutes → long).
 * median_pct: median + Math.floor(median × pctTenths / 1000); median_plus: median + amountCents;
 * median null (fewer than 3 fares) → fallbackCents with source 'fallback'; mode none → cents null.
 * A route override's cap gives source 'route' whatever its mode.
 * @param {import('../types').PolicyRules} rules
 * @param {import('../types').FlightRow} row
 * @param {import('../types').Benchmark|null} benchmark the same leg's (search result legs[row.leg].benchmark)
 * @returns {import('../types').FlightCap}
 */
function flightCap(rules, row, benchmark) {
  const p = flightCapParts(rules, row, benchmark);
  return { cents: p.cents, source: p.override ? 'route' : p.how, haul: p.haul, medianCents: p.medianCents };
}

/** Everything flightCap and the flight rules need: the haul, its band, the matching override and the cap. */
function flightCapParts(rules, row, benchmark) {
  const haul = haulOf(rules, row);
  const band = bandOf(rules, haul);
  const medianCents = benchmark && Number.isSafeInteger(benchmark.medianCents) ? benchmark.medianCents : null;
  const override = routeOverrideFor(rules, row);
  const capRule = override ? override.cap : band.cap;
  const { cents, how } = capCents(capRule, medianCents);
  return { haul, band, override, capRule, cents, how, medianCents };
}

/**
 * The nightly limit for one hotel row: the city cap inside its country, else the country cap, else the
 * default (names compared case-insensitively after NFKC). cents null when none applies.
 * @param {import('../types').PolicyRules} rules
 * @param {import('../types').HotelRow} row
 * @returns {import('../types').HotelCap}
 */
function hotelCap(rules, row) {
  const h = rules.hotels;
  const country = (h.countryCaps || []).find(c => nameKey(c.country) === nameKey(row.country));
  if (country) {
    const city = (country.cities || []).find(c => nameKey(c.city) === nameKey(row.city));
    if (city) return { cents: city.nightlyCents, source: 'city', basis: h.capBasis };
    return { cents: country.nightlyCents, source: 'country', basis: h.capBasis };
  }
  if (h.defaultNightlyCents != null) return { cents: h.defaultNightlyCents, source: 'default', basis: h.capBasis };
  return { cents: null, source: 'none', basis: h.capBasis };
}

/** A stay's total on the cap basis: incl_taxes → the total; excl_taxes → the total less its tax lines. */
function basisTotal(row, basis) {
  if (basis !== 'excl_taxes') return row.totalCents;
  const tax = (row.lines || []).filter(l => l.kind === 'tax').reduce((n, l) => n + l.cents, 0);
  return row.totalCents - tax;
}

const basisText = basis => (basis === 'excl_taxes' ? 'before taxes' : 'taxes included');

function rollUp(violations, outOfPolicy) {
  if (violations.some(v => v.severity === 'block')) return 'blocked';
  if (outOfPolicy === 'block' && violations.some(v => v.rule !== 'budget')) return 'blocked';
  return violations.length ? 'out' : 'within';
}

const byRule = (a, b) => RULE_ORDER[a.rule] - RULE_ORDER[b.rule];

function advanceText(days, min) {
  if (days < 0) return `This date has already passed. Your policy asks for ${plural(min, 'day')} ahead.`;
  const planned = days === 0 ? 'Planned for the same day' : `Planned ${plural(days, 'day')} ahead`;
  return `${planned}. Your policy asks for ${min}.`;
}

function evaluateFlight(row, ctx) {
  const { rules } = ctx;
  const c = row.leg;
  const out = [];
  const bench = ctx.benchmarks ? ctx.benchmarks[row.leg] || null : null;
  const { haul, band, override, capRule, cents, how } = flightCapParts(rules, row, bench);
  let overCents = 0;
  if (row.available === true && cents != null && row.totalCents > cents) {
    overCents = row.totalCents - cents;
    const where = override ? ' for this route' : '';
    out.push(violation('flight.cap', c, cents, row.totalCents,
      `Over your ${format(cents)} limit${where} by ${format(overCents)}${capReason(capRule, how, priceSourceOf(ctx, row))}.`));
  }
  const maxCabin = override && override.maxCabin != null ? override.maxCabin : band.maxCabin;
  if (CABIN_RANK[row.cabin] > CABIN_RANK[maxCabin]) {
    const scope = override && override.maxCabin != null ? 'on this route'
      : haul === 'long' ? `for flights of ${hoursText(rules.flights.longHaulMinutes)} or more`
        : `for flights under ${hoursText(rules.flights.longHaulMinutes)}`;
    out.push(violation('flight.cabin', c, maxCabin, row.cabin, `${cabinName(row.cabin)} is above your limit (${CABIN_LABELS[maxCabin]}) ${scope}.`));
  }
  const departDate = row.segments && row.segments.length ? row.segments[0].departLocal.slice(0, 10) : null;
  if (departDate && band.minAdvanceDays > 0) {
    const days = daysBetween(ctx.today, departDate);
    if (days < band.minAdvanceDays) out.push(violation('flight.advance', c, band.minAdvanceDays, days, advanceText(days, band.minAdvanceDays)));
  }
  if (band.maxStops != null && row.stops > band.maxStops) {
    const allows = band.maxStops === 0 ? 'nonstop only' : `up to ${band.maxStops}`;
    out.push(violation('flight.stops', c, band.maxStops, row.stops, `${plural(row.stops, 'stop')}. Your policy allows ${allows}.`));
  }
  const refundPct = row.fare ? row.fare.refundablePercent : 0;
  if (band.refundableOnly && !(refundPct > 0)) {
    const fareName = row.fare && row.fare.name ? row.fare.name : 'This fare';
    // A supplier fare whose refund the airline doesn't confirm: its 0% is a placeholder, not a fact.
    const unconfirmed = sourceOf(row) !== 'demo' && refundsUnconfirmed(row.fare ? row.fare.terms : null, { currency: row.currency || 'USD' });
    out.push(violation('flight.refundable', c, null, refundPct, unconfirmed
      ? `Your policy asks for a fare that refunds at least part of the price, and Tripelyx can't confirm that for ${row.fare && row.fare.name ? row.fare.name : 'this fare'}.`
      : `Your policy asks for a fare that refunds at least part of the price. ${fareName} refunds nothing.`));
  }
  const blocked = new Set(rules.flights.blockedCarriers || []);
  const seen = new Set();
  for (const s of [{ carrier: row.carrier }, ...(row.segments || [])]) {
    const code = s.carrier && s.carrier.code;
    if (!code || seen.has(code) || !blocked.has(code)) continue;
    seen.add(code);
    const name = (ctx.carriers && ctx.carriers[code]) || s.carrier.name || code;
    out.push(violation('flight.carrier', c, code, code, `${name} isn't used by ${ctx.orgName || 'your company'}.`));
  }
  if (row.available !== true) out.push(violation('inventory.unavailable', c, null, null, unavailableText(row)));
  const violations = out.sort(byRule);
  return { status: rollUp(violations, ctx.outOfPolicy), violations, cap: { cents, source: override ? 'route' : how, haul }, overCents };
}

function evaluateHotel(row, ctx) {
  const h = ctx.rules.hotels;
  const out = [];
  const cap = hotelCap(ctx.rules, row);
  let overCents = 0;
  if (row.available === true && cap.cents != null) {
    const limit = cap.cents * row.nights;
    const actual = basisTotal(row, cap.basis);
    if (actual > limit) {
      overCents = actual - limit;
      let nightly = Math.round(actual / row.nights);
      if (nightly <= cap.cents) nightly = cap.cents + 1;
      const place = cap.source === 'city' ? `the ${row.city} limit` : cap.source === 'country' ? `the ${row.country} limit` : 'your hotel limit';
      out.push(violation('hotel.cap', 'hotel', limit, actual,
        `${format(nightly)} a night is over ${place} of ${format(cap.cents)} (${basisText(cap.basis)}).`));
    }
  }
  if (h.maxStars != null && row.stars > h.maxStars) {
    out.push(violation('hotel.stars', 'hotel', h.maxStars, row.stars, `${row.stars}-star hotel. Your policy allows up to ${plural(h.maxStars, 'star')}.`));
  } else if (h.maxStars != null && row.stars === 0 && sourceOf(row) !== 'demo') {
    // A supplier hotel with no star rating can't be shown to be inside the limit: an approver decides.
    out.push(violation('hotel.stars', 'hotel', h.maxStars, 0,
      `This hotel has no star rating from the supplier, so it needs approval under your up to ${plural(h.maxStars, 'star')} rule.`));
  }
  if (h.minAdvanceDays > 0) {
    const days = daysBetween(ctx.today, row.checkIn);
    if (days < h.minAdvanceDays) out.push(violation('hotel.advance', 'hotel', h.minAdvanceDays, days, advanceText(days, h.minAdvanceDays)));
  }
  const refundable = !!(row.cancellation && row.cancellation.refundable === true);
  if (h.refundableOnly && !refundable) {
    out.push(violation('hotel.refundable', 'hotel', null, false, "Your policy asks for a room you can cancel. This rate can't be cancelled."));
  }
  if (row.available !== true) out.push(violation('inventory.unavailable', 'hotel', null, null, unavailableText(row)));
  const violations = out.sort(byRule);
  return { status: rollUp(violations, ctx.outOfPolicy), violations, cap: { cents: cap.cents, source: cap.source, basis: cap.basis }, overCents };
}

/**
 * Evaluate one row against ctx.rules.
 * @param {import('../types').Row} row a FlightRow (uses ctx.benchmarks[row.leg]) or a HotelRow (ctx.benchmarks.hotel)
 * @param {import('../types').EvalCtx} ctx
 * @returns {import('../types').Evaluation}
 */
function evaluateComponent(row, ctx) {
  if (!row || (row.kind !== 'flight' && row.kind !== 'hotel')) throw new TypeError('[business] evaluateComponent needs a flight or hotel row');
  if (!ctx || !ctx.rules) throw new TypeError('[business] evaluateComponent needs ctx.rules');
  return row.kind === 'flight' ? evaluateFlight(row, ctx) : evaluateHotel(row, ctx);
}

/**
 * Evaluate a whole trip: each component, then trip.cap on the total and the budget check.
 * @param {{ out: import('../types').FlightRow, back?: import('../types').FlightRow|null, hotel?: import('../types').HotelRow|null }} rows
 * @param {import('../types').EvalCtx} ctx
 * @param {{ budget: import('../types').BudgetCtx|null }} opts budget null: no budget for the period (no violation);
 *   budget.periodLabel is the period in words for the text (never computed here, so evaluate stays pure)
 * @returns {import('../types').TripEvaluation} components holds only the components given; totalCents = Σ rows
 *   (Σ of the priced ones when something is unavailable)
 */
function evaluateTrip(rows, ctx, opts = {}) {
  const budget = opts && opts.budget ? opts.budget : null;
  if (budget && (typeof budget.periodLabel !== 'string' || !budget.periodLabel)) {
    throw new TypeError('[business] BudgetCtx needs periodLabel (budgets.periodLabel(periodKey)): evaluate stays pure');
  }
  if (!rows || !rows.out) throw new TypeError('[business] a trip needs an outbound flight');
  const components = {};
  const violations = [];
  let status = 'within';
  let totalCents = 0;
  let priced = true;
  for (const c of ['out', 'back', 'hotel']) {
    const row = rows[c];
    if (!row) continue;
    const e = evaluateComponent(row, ctx);
    components[c] = e;
    violations.push(...e.violations);
    if (STATUS_RANK[e.status] > STATUS_RANK[status]) status = e.status;
    if (row.available === true && Number.isSafeInteger(row.totalCents)) totalCents += row.totalCents;
    else priced = false;
  }
  const max = ctx.rules.trip ? ctx.rules.trip.maxTotalCents : null;
  if (priced && max != null && totalCents > max) {
    violations.push(violation('trip.cap', 'trip', max, totalCents, `The trip total is over your ${format(max)} trip limit by ${format(totalCents - max)}.`));
    const s = ctx.outOfPolicy === 'block' ? 'blocked' : 'out';
    if (STATUS_RANK[s] > STATUS_RANK[status]) status = s;
  }
  if (priced && budget && totalCents > budget.remainingCents) {
    const text = budget.remainingCents > 0
      ? `This trip would use ${format(totalCents)} of the ${format(budget.remainingCents)} left in ${budget.departmentName} for ${budget.periodLabel}.`
      : `This trip would use ${format(totalCents)}, and ${budget.departmentName} has nothing left for ${budget.periodLabel}.`;
    violations.push(violation('budget', 'trip', budget.remainingCents, totalCents, text));
    if (status === 'within') status = 'out';
  }
  return { status, components, violations, totalCents, policy: { tier: ctx.policy.tier, version: ctx.policy.version } };
}

/**
 * Hotel Price to Beat: min(cap, median) when both exist, else whichever exists, else null.
 * @param {number|null} capCents the city's nightly cap on the policy basis
 * @param {import('../types').Benchmark|null} hotelBenchmark on the policy basis
 * @returns {number|null}
 */
function priceToBeat(capCents, hotelBenchmark) {
  const median = hotelBenchmark && Number.isSafeInteger(hotelBenchmark.medianCents) ? hotelBenchmark.medianCents : null;
  const cap = Number.isSafeInteger(capCents) ? capCents : null;
  if (cap == null) return median;
  return median == null ? cap : Math.min(cap, median);
}

module.exports = { RULE_IDS, STATUS_RANK, flightCap, hotelCap, evaluateComponent, evaluateTrip, priceToBeat };
