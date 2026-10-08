// A travel policy in plain words (plan §B6 "Your travel policy", §E4 limits bar). Pure: no store, no clock.
//
// Copy rules: no em dash, none of the PRESSURE words (test/experience-pages.test.js:49), amounts through
// lib/money. Hotel stars are labelled as a Tripelyx addition where the editor shows them.
//
// describe() lines, for example:
//   "Flights under 6 hours: Economy, with fares up to the median of the demo fares in your search plus 20% (or
//    $600 if there aren't enough fares to compare), at most 1 stop."
//   "Flights of 6 hours or more: up to Premium economy, with fares up to the median of the demo fares in your
//    search plus 20% (or $1,500 if there aren't enough fares to compare), at most 1 stop."
//   "Plan flights at least 7 days ahead."  (or both bands in one line when they differ)
//   "CAI to LHR and back: up to Business class, with fares up to $900 each way."
//   "Hotels: up to $180 a night, taxes included."
//   "Nightly limits by country: United Kingdom $260 (London $300), Egypt $150 (Cairo $160)."
//   "Up to 4-star hotels."
//   "Sahara Wings isn't used by Acme Inc."
// limitsBar() for one search, for example:
//   heading 'Your limits for this search (Standard policy, v3)'
//   { key: 'flight.short', text: 'Flights under 6 hours: Economy, up to', cents: 71200, suffix: 'each way (median of these demo fares plus 20%)' }
//   { key: 'flight.advance', text: 'Plan 7 days ahead', cents: null, suffix: '' }
//   { key: 'hotel.cap', text: 'Hotels in London: up to', cents: 30000, suffix: 'a night, taxes included' }
//   { key: 'hotel.priceToBeat', text: 'Price to Beat:', cents: 26400, suffix: 'a night (the lower of your limit and the middle rate of this search)' }
// When the outbound and return legs of a search end up with different flight caps (each leg's median is its
// own), the bar has one item per leg ('flight.out.short', 'flight.back.short') instead of one "each way" item.
const { format } = require('../../lib/money');
const { CABIN_LABELS, TIER_LABELS } = require('../constants');
const { flightCap, hotelCap, priceToBeat } = require('./evaluate');

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function hoursText(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return [h ? plural(h, 'hour') : '', m ? plural(m, 'minute') : ''].filter(Boolean).join(' ');
}
const pctText = tenths => (tenths % 10 ? `${(tenths - (tenths % 10)) / 10}.${tenths % 10}` : String(tenths / 10));
const cabinName = cabin => (cabin === 'business' ? 'Business class' : CABIN_LABELS[cabin]);
/** "Economy" for the lowest cabin, else "up to Premium economy" / "up to Business class". */
const cabinPhrase = cabin => (cabin === 'economy' ? 'Economy' : `up to ${cabinName(cabin)}`);
const basisText = basis => (basis === 'excl_taxes' ? 'before taxes' : 'taxes included');

const haulPhrase = (haul, minutes) => (haul === 'long' ? `Flights of ${hoursText(minutes)} or more` : `Flights under ${hoursText(minutes)}`);

/** A cap in words, for the policy page. */
function capPhrase(cap) {
  switch (cap.mode) {
    case 'fixed': return `with fares up to ${format(cap.amountCents)} each way`;
    case 'median_pct':
      return `with fares up to the median of the demo fares in your search plus ${pctText(cap.pctTenths)}% (or ${format(cap.fallbackCents)} if there aren't enough fares to compare)`;
    case 'median_plus':
      return `with fares up to the median of the demo fares in your search plus ${format(cap.amountCents)} (or ${format(cap.fallbackCents)} if there aren't enough fares to compare)`;
    default: return 'with no price limit';
  }
}

function stopsPhrase(maxStops) {
  if (maxStops == null) return '';
  return maxStops === 0 ? 'nonstop only' : `at most ${plural(maxStops, 'stop')}`;
}

/**
 * The member-facing summary of one tier's rules.
 * @param {import('../types').PolicyRules} rules
 * @param {{ tier: import('../types').Tier, version: number, orgName: string, carriers: Record<string, string> }} opts
 * @returns {import('../types').PolicyDescription} title 'Your travel policy', sub '<Tier> policy, version <n>'
 */
function describe(rules, { tier, version, orgName, carriers = {} } = {}) {
  const f = rules.flights, h = rules.hotels;
  const lines = [];
  for (const [haul, band] of [['short', f.shortHaul], ['long', f.longHaul]]) {
    const parts = [cabinPhrase(band.maxCabin), capPhrase(band.cap), stopsPhrase(band.maxStops),
      band.refundableOnly ? 'on a fare that refunds at least part of the price' : ''].filter(Boolean);
    lines.push(`${haulPhrase(haul, f.longHaulMinutes)}: ${parts.join(', ')}.`);
  }
  const a = f.shortHaul.minAdvanceDays, b = f.longHaul.minAdvanceDays;
  if (a === b && a > 0) lines.push(`Plan flights at least ${plural(a, 'day')} ahead.`);
  else if (a !== b) {
    const say = (n, what) => (n > 0 ? `${what} at least ${plural(n, 'day')} ahead` : `${what} any time ahead`);
    lines.push(`Plan ${say(a, `flights under ${hoursText(f.longHaulMinutes)}`)}, and ${say(b, 'longer ones')}.`);
  }
  for (const o of f.routeOverrides) {
    const parts = [o.maxCabin ? cabinPhrase(o.maxCabin) : '', capPhrase(o.cap)].filter(Boolean);
    lines.push(`${o.from} to ${o.to}${o.bothWays ? ' and back' : ''}: ${parts.join(', ')}.`);
  }
  if (h.defaultNightlyCents != null) lines.push(`Hotels: up to ${format(h.defaultNightlyCents)} a night, ${basisText(h.capBasis)}.`);
  else if (h.countryCaps.length) lines.push(`Hotels: no nightly limit outside the countries below (limits ${basisText(h.capBasis)}).`);
  else lines.push('Hotels: no nightly limit.');
  if (h.countryCaps.length) {
    const items = h.countryCaps.map(c => {
      const cities = c.cities.map(x => `${x.city} ${format(x.nightlyCents)}`).join(', ');
      return `${c.country} ${format(c.nightlyCents)}${cities ? ` (${cities})` : ''}`;
    });
    lines.push(`Nightly limits by country: ${items.join(', ')}.`);
  }
  if (h.maxStars != null) lines.push(`Up to ${h.maxStars}-star hotels.`);
  if (h.minAdvanceDays > 0) lines.push(`Book hotels at least ${plural(h.minAdvanceDays, 'day')} ahead.`);
  if (h.refundableOnly) lines.push('Hotel rooms you can cancel.');
  if (rules.trip.maxTotalCents != null) lines.push(`Trips up to ${format(rules.trip.maxTotalCents)} in total.`);
  for (const code of f.blockedCarriers) lines.push(`${carriers[code] || code} isn't used by ${orgName || 'your company'}.`);
  return { title: 'Your travel policy', sub: `${TIER_LABELS[tier] || tier} policy, version ${version}`, lines };
}

/** Why a cap is what it is, for the bar: "(median of these demo fares plus 20%)". */
function barReason(cap, source) {
  if (source === 'fallback') return "(this search has too few demo fares to compare, so your set limit applies)";
  if (cap.mode === 'median_pct') return `(median of these demo fares plus ${pctText(cap.pctTenths)}%)`;
  if (cap.mode === 'median_plus') return `(median of these demo fares plus ${format(cap.amountCents)})`;
  return '';
}

/** The cap facts of one leg: one entry per band (or route) its rows fall in, in short, long, route order. */
function legCaps(rules, leg) {
  const out = new Map();
  if (!leg || !Array.isArray(leg.rows)) return out;
  for (const row of leg.rows) {
    if (!row || row.kind !== 'flight') continue;
    const fc = flightCap(rules, row, leg.benchmark || null);
    const f = rules.flights;
    const { from, to } = { from: row.segments[0].from.code, to: row.segments[row.segments.length - 1].to.code };
    const override = fc.source === 'route'
      ? f.routeOverrides.find(o => (o.from === from && o.to === to) || (o.bothWays && o.from === to && o.to === from)) : null;
    const band = fc.haul === 'long' ? f.longHaul : f.shortHaul;
    const key = override ? 'route' : fc.haul;
    if (out.has(key)) continue;
    const capRule = override ? override.cap : band.cap;
    const source = capRule.mode === 'median_pct' || capRule.mode === 'median_plus' ? (fc.medianCents == null ? 'fallback' : 'median') : capRule.mode;
    out.set(key, {
      key, haul: fc.haul, cents: fc.cents, capRule, source,
      cabin: override && override.maxCabin ? override.maxCabin : band.maxCabin,
      label: override ? `Flights between ${override.from} and ${override.to}` : haulPhrase(fc.haul, f.longHaulMinutes),
      advance: band.minAdvanceDays,
    });
  }
  return out;
}

const ORDER = ['short', 'long', 'route'];

/**
 * The "Your limits for this search" bar: the cap of each haul band the search's rows fall in (route
 * overrides included), the advance-days rule, the hotel city's cap and the Price to Beat.
 * @param {import('../types').PolicyRules} rules
 * @param {import('../types').EvalCtx} ctx
 * @param {import('../types').SearchResult} search
 * @returns {import('../types').LimitsBar}
 */
function limitsBar(rules, ctx, search) {
  const tierLabel = TIER_LABELS[ctx.policy.tier] || ctx.policy.tier;
  const heading = `Your limits for this search (${tierLabel} policy, v${ctx.policy.version})`;
  const items = [];
  const legs = (search && search.legs) || {};
  const out = legCaps(rules, legs.out), back = legCaps(rules, legs.back);
  const lower = s => s.charAt(0).toLowerCase() + s.slice(1);
  // leg: null for an item that covers every flight leg of the search ("each way" on a return trip).
  const flightItem = (k, cap, leg) => {
    const key = leg ? `flight.${leg}.${k}` : `flight.${k}`;
    const label = leg ? `${leg === 'out' ? 'Outbound' : 'Return'} ${lower(cap.label)}` : cap.label;
    if (cap.cents == null) return { key, text: `${label}: ${cabinPhrase(cap.cabin)}, no price limit`, cents: null, suffix: '' };
    const eachWay = !leg && !!legs.back;
    return { key, text: `${label}: ${cabinPhrase(cap.cabin)}, up to`, cents: cap.cents, suffix: [eachWay ? 'each way' : '', barReason(cap.capRule, cap.source)].filter(Boolean).join(' ') };
  };
  for (const k of ORDER) {
    const a = out.get(k), b = back.get(k);
    if (a && b && a.cents === b.cents && a.cabin === b.cabin && a.source === b.source) items.push(flightItem(k, a, null));
    else {
      if (a) items.push(flightItem(k, a, legs.back ? 'out' : null));
      if (b) items.push(flightItem(k, b, 'back'));
    }
  }
  const advances = [...new Set([...out.values(), ...back.values()].filter(c => c.key !== 'route').map(c => c.advance))].filter(n => n > 0).sort((x, y) => y - x);
  if (advances.length) items.push({ key: 'flight.advance', text: `Plan ${plural(advances[0], 'day')} ahead`, cents: null, suffix: '' });
  const hq = search && search.query && search.query.hotel;
  if (legs.hotel && hq) {
    const cap = hotelCap(rules, { city: hq.city, country: hq.country });
    const basis = rules.hotels.capBasis;
    const bench = legs.hotel.benchmark ? legs.hotel.benchmark[basis] || null : null;
    if (cap.cents != null) items.push({ key: 'hotel.cap', text: `Hotels in ${hq.city}: up to`, cents: cap.cents, suffix: `a night, ${basisText(basis)}` });
    else items.push({ key: 'hotel.cap', text: `Hotels in ${hq.city}: no nightly limit`, cents: null, suffix: '' });
    const ptb = priceToBeat(cap.cents, bench);
    if (ptb != null) {
      const median = bench && bench.medianCents != null ? bench.medianCents : null;
      const why = cap.cents != null && median != null ? 'the lower of your limit and the middle rate of this search'
        : cap.cents != null ? 'your limit, as this search has too few hotels to compare' : 'the middle rate of this search';
      items.push({ key: 'hotel.priceToBeat', text: 'Price to Beat:', cents: ptb, suffix: `a night (${why})` });
    }
    if (rules.hotels.maxStars != null) items.push({ key: 'hotel.stars', text: `Up to ${rules.hotels.maxStars}-star hotels`, cents: null, suffix: '' });
  }
  if (rules.trip.maxTotalCents != null) items.push({ key: 'trip.cap', text: 'Trip total: up to', cents: rules.trip.maxTotalCents, suffix: '' });
  return { heading, items };
}

module.exports = { describe, limitsBar };
