// Policy rules from the editor's form, and back (plan §E1). Pure: no store, no clock.
//
// Every PolicyRules a company stores went through normalizePolicy: unknown keys, a 'first' cabin, negative
// money, unknown airports or carriers and over-long lists are refused with per-field details. Money is
// parsed with validate.dollarsToCents and percentages with validate.percentTenths (string arithmetic).
//
// Settled details:
// - Fields outside the policy's own names (rev, note, a CSRF field, …) are ignored; an unknown name inside a
//   policy group (short.*, long.*, route.*, hotel.*, country.*, trip.*) is refused under its own name.
// - A field sent twice (an array) where one value is expected is refused under its name.
// - Blank minAdvanceDays means 0; blank maxStops means any; an unticked box (absent, '' or '0') means false.
// - Money caps, fallbacks, hotel caps and the trip limit must be above $0; a median_plus margin may be $0.
// - Route rows: from must differ from to; a row that an earlier row already covers (same direction, or the
//   reverse of an earlier bothWays row) is refused, since the first match wins and it could never apply.
// - Country names come from refs.countries when the inventory knows any (spelled as the inventory spells them,
//   whatever case was typed); with no supplier connected (an empty list) any name is taken as typed, so the
//   policy can still be saved. City names are free text. Names repeat neither across countries nor within one.
// - Airport and carrier codes must be in refs (empty lists refuse every code), uppercased.
const { AppError } = require('../../lib/errors');
const v = require('../validate');
const { CABINS } = require('../constants');

/** Cap modes, in the editor's order. */
const CAP_MODES = Object.freeze(['none', 'fixed', 'median_pct', 'median_plus']);

/** Limits normalizePolicy enforces (money: whatever validate.dollarsToCents accepts, which is under $10 million). */
const LIMITS = Object.freeze({
  longHaulMinutes: Object.freeze([60, 1200]),
  minAdvanceDays: Object.freeze([0, 365]),
  pctTenths: Object.freeze([0, 999]),
  routeOverrides: 50,
  blockedCarriers: 20,
  countryCaps: 60,
  citiesPerCountry: 20,
  nameChars: 80,   // a country or city name
  noteChars: 300,  // "What changed?" (policies.savePolicy)
});

const BAND_FIELDS = Object.freeze(['capMode', 'capAmount', 'capPct', 'fallback', 'maxCabin', 'minAdvanceDays', 'maxStops', 'refundableOnly']);
const ROUTE_FIELDS = Object.freeze(['from', 'to', 'bothWays', 'capMode', 'capAmount', 'capPct', 'fallback', 'maxCabin']);
const HOTEL_FIELDS = Object.freeze(['capBasis', 'default', 'maxStars', 'minAdvanceDays', 'refundableOnly']);
const CAP_BASES = Object.freeze(['incl_taxes', 'excl_taxes']);
const GROUPS = /^(short|long|route|hotel|country|trip)\./;
const INDEX = '(0|[1-9]\\d{0,2})';
const ROUTE_KEY = new RegExp(`^route\\.${INDEX}\\.([A-Za-z]+)$`);
const COUNTRY_KEY = new RegExp(`^country\\.${INDEX}\\.(name|nightly)$`);
const CITY_KEY = new RegExp(`^country\\.${INDEX}\\.city\\.${INDEX}\\.(name|nightly)$`);
const CODE_RE = /^[A-Z0-9]{2,3}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const invalid = message => new AppError('invalid_field', message, 422);
const nameKey = s => String(s ?? '').normalize('NFKC').trim().toLowerCase();

/** Is this one of the form's own policy field names? */
function knownField(key) {
  if (key === 'longHaulMinutes' || key === 'blockedCarriers' || key === 'trip.maxTotal') return true;
  const band = /^(short|long)\.(.+)$/.exec(key);
  if (band) return BAND_FIELDS.includes(band[2]);
  const hotel = /^hotel\.(.+)$/.exec(key);
  if (hotel) return HOTEL_FIELDS.includes(hotel[1]);
  const route = ROUTE_KEY.exec(key);
  if (route) return ROUTE_FIELDS.includes(route[2]);
  return COUNTRY_KEY.test(key) || CITY_KEY.test(key);
}

/**
 * Build PolicyRules from the editor's form (types.PolicyForm lists every field name).
 * @param {import('../types').PolicyForm} form the url-encoded body (extra fields such as rev and note are ignored)
 * @param {import('../types').PolicyRefs} refs codes the inventory knows (empty lists refuse every code)
 * @returns {import('../types').PolicyRules} every key present, lists in the form's order
 * @throws {AppError} 422 'invalid_policy', message 'Check the highlighted fields.', details { [form field]: message }
 */
function normalizePolicy(form, refs) {
  const f = form && typeof form === 'object' ? form : {};
  const r = refs && typeof refs === 'object' ? refs : {};
  const airports = new Set((r.airports || []).map(c => String(c).toUpperCase()));
  const carriers = new Set((r.carriers || []).map(c => String(c).toUpperCase()));
  const countryNames = new Map((r.countries || []).map(c => [nameKey(c), String(c)]));
  const details = {};
  const keys = Object.keys(f);
  const has = k => Object.hasOwn(f, k);

  // One field: run fn on its (single) value, keep the result or record the message under the field's name.
  const field = (key, fn) => {
    const raw = has(key) ? f[key] : undefined;
    if (Array.isArray(raw)) { details[key] = 'Choose one value.'; return undefined; }
    try { return fn(raw); } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'invalid_field') throw e;
      details[key] = e.message;
      return undefined;
    }
  };
  const blank = raw => raw === undefined || raw === null || String(raw).trim() === '';
  const choice = (list, message, { allowBlank = false } = {}) => raw => {
    if (allowBlank && blank(raw)) return null;
    const s = String(raw ?? '').trim();
    if (!list.includes(s)) throw invalid(message);
    return s;
  };
  const wholeNumber = ([min, max], message, { blankAs } = {}) => raw => {
    if (blank(raw) && blankAs !== undefined) return blankAs;
    const s = String(raw ?? '').trim();
    if (!/^\d{1,4}$/.test(s)) throw invalid(message);
    const n = Number(s);
    if (n < min || n > max) throw invalid(message);
    return n;
  };
  const tick = raw => {
    const s = String(raw ?? '').trim();
    if (s === '' || s === '0') return false;
    if (s === '1') return true;
    throw invalid('Tick or untick this box.');
  };
  const money = ({ optional = false, zero = false } = {}) => raw => {
    const cents = v.dollarsToCents(raw, optional ? { blank: null } : {});
    if (cents !== null && !zero && cents <= 0) throw invalid('Enter an amount above $0.');
    return cents;
  };
  const advance = wholeNumber(LIMITS.minAdvanceDays, 'Enter a number of days from 0 to 365.', { blankAs: 0 });
  const cabin = choice(CABINS, 'Choose Economy, Premium economy or Business.');

  // Unknown names inside the policy's groups.
  for (const key of keys) {
    if (GROUPS.test(key) && !knownField(key)) details[key] = "This field isn't part of a travel policy.";
  }

  const cap = prefix => {
    const mode = field(`${prefix}.capMode`, choice(CAP_MODES, 'Choose how the price limit works.'));
    switch (mode) {
      case 'none': return { mode: 'none' };
      case 'fixed': {
        const amountCents = field(`${prefix}.capAmount`, money());
        return { mode: 'fixed', amountCents };
      }
      case 'median_pct': {
        const pctTenths = field(`${prefix}.capPct`, raw => v.percentTenths(raw, { max: LIMITS.pctTenths[1] }));
        const fallbackCents = field(`${prefix}.fallback`, money());
        return { mode: 'median_pct', pctTenths, fallbackCents };
      }
      case 'median_plus': {
        const amountCents = field(`${prefix}.capAmount`, money({ zero: true }));
        const fallbackCents = field(`${prefix}.fallback`, money());
        return { mode: 'median_plus', amountCents, fallbackCents };
      }
      default: return undefined;
    }
  };
  const band = prefix => ({
    cap: cap(prefix),
    maxCabin: field(`${prefix}.maxCabin`, cabin),
    minAdvanceDays: field(`${prefix}.minAdvanceDays`, advance),
    maxStops: field(`${prefix}.maxStops`, raw => {
      if (blank(raw)) return null;
      const s = String(raw).trim();
      if (s !== '0' && s !== '1') throw invalid('Choose nonstop only, up to 1 stop, or any.');
      return Number(s);
    }),
    refundableOnly: field(`${prefix}.refundableOnly`, tick),
  });

  const longHaulMinutes = field('longHaulMinutes', wholeNumber(LIMITS.longHaulMinutes, 'Enter a number of minutes from 60 to 1,200.'));
  const shortHaul = band('short');
  const longHaul = band('long');

  // Route exceptions, in index order; rows with a blank from are left out.
  const routeIndexes = [...new Set(keys.map(k => ROUTE_KEY.exec(k)).filter(Boolean).map(m => Number(m[1])))].sort((a, b) => a - b);
  const routeOverrides = [];
  for (const n of routeIndexes) {
    const p = `route.${n}`;
    if (Array.isArray(f[`${p}.from`])) { details[`${p}.from`] = 'Choose one value.'; continue; }
    if (blank(f[`${p}.from`])) continue;
    if (routeOverrides.length >= LIMITS.routeOverrides) { details[`${p}.from`] = `Up to ${LIMITS.routeOverrides} route exceptions.`; break; }
    const code = which => raw => {
      const s = String(raw ?? '').trim().toUpperCase();
      if (!CODE_RE.test(s) || !airports.has(s)) throw invalid(which === 'from' ? 'Choose an airport to leave from.' : 'Choose an airport to fly to.');
      return s;
    };
    const from = field(`${p}.from`, code('from'));
    const to = field(`${p}.to`, code('to'));
    const bothWays = field(`${p}.bothWays`, tick);
    const routeCap = cap(p);
    const maxCabin = field(`${p}.maxCabin`, raw => (blank(raw) ? null : cabin(raw)));
    if (from && to) {
      if (from === to) details[`${p}.to`] = 'Choose a different airport from the one you leave from.';
      else if (routeOverrides.some(o => (o.from === from && o.to === to) || (o.bothWays && o.from === to && o.to === from))) {
        details[`${p}.from`] = 'An earlier route exception already covers this route.';
      }
    }
    routeOverrides.push({ from, to, bothWays, cap: routeCap, maxCabin });
  }

  // Blocked carriers: one value per ticked code (a single string or a list).
  const blockedRaw = has('blockedCarriers') ? f.blockedCarriers : [];
  const blockedCarriers = [];
  for (const raw of Array.isArray(blockedRaw) ? blockedRaw : [blockedRaw]) {
    const s = String(raw ?? '').trim().toUpperCase();
    if (!s) continue;
    if (!CODE_RE.test(s) || !carriers.has(s)) { details.blockedCarriers = 'Choose airlines from the list.'; continue; }
    if (!blockedCarriers.includes(s)) blockedCarriers.push(s);
  }
  if (blockedCarriers.length > LIMITS.blockedCarriers) details.blockedCarriers = `Up to ${LIMITS.blockedCarriers} airlines.`;

  // Hotels.
  const capBasis = field('hotel.capBasis', choice(CAP_BASES, 'Choose whether hotel limits include taxes.'));
  const defaultNightlyCents = field('hotel.default', money({ optional: true }));
  const maxStars = field('hotel.maxStars', wholeNumber([1, 5], 'Choose 1 to 5 stars, or any.', { blankAs: null }));
  const hotelAdvance = field('hotel.minAdvanceDays', advance);
  const hotelRefundable = field('hotel.refundableOnly', tick);

  const placeName = (raw, message) => {
    const s = v.text(raw, LIMITS.nameChars + 1);
    if (!s) throw invalid(message);
    if (s.length > LIMITS.nameChars) throw invalid(`Keep names to ${LIMITS.nameChars} characters.`);
    if (LONE_SURROGATE.test(s)) throw invalid('Use letters, spaces and punctuation only.');
    return s;
  };
  const countryIndexes = [...new Set(keys.map(k => COUNTRY_KEY.exec(k) || CITY_KEY.exec(k)).filter(Boolean).map(m => Number(m[1])))].sort((a, b) => a - b);
  const cityIndexesOf = new Map();
  for (const m of keys.map(k => CITY_KEY.exec(k)).filter(Boolean)) {
    const n = Number(m[1]);
    if (!cityIndexesOf.has(n)) cityIndexesOf.set(n, new Set());
    cityIndexesOf.get(n).add(Number(m[2]));
  }
  const countryCaps = [];
  for (const n of countryIndexes) {
    const p = `country.${n}`;
    if (Array.isArray(f[`${p}.name`])) { details[`${p}.name`] = 'Choose one value.'; continue; }
    if (blank(f[`${p}.name`])) continue;
    if (countryCaps.length >= LIMITS.countryCaps) { details[`${p}.name`] = `Up to ${LIMITS.countryCaps} countries.`; break; }
    let country = field(`${p}.name`, raw => placeName(raw, 'Enter a country.'));
    if (country !== undefined && countryNames.size) {
      const known = countryNames.get(nameKey(country));
      if (known) country = known;
      else { details[`${p}.name`] = 'Choose a country from the list.'; country = undefined; }
    }
    if (country !== undefined && countryCaps.some(c => nameKey(c.country) === nameKey(country))) {
      details[`${p}.name`] = 'This country is already listed.';
    }
    const nightlyCents = field(`${p}.nightly`, money());
    const cityIndexes = [...(cityIndexesOf.get(n) || [])].sort((a, b) => a - b);
    const cities = [];
    for (const m of cityIndexes) {
      const q = `${p}.city.${m}`;
      if (Array.isArray(f[`${q}.name`])) { details[`${q}.name`] = 'Choose one value.'; continue; }
      if (blank(f[`${q}.name`])) continue;
      if (cities.length >= LIMITS.citiesPerCountry) { details[`${q}.name`] = `Up to ${LIMITS.citiesPerCountry} cities in a country.`; break; }
      const city = field(`${q}.name`, raw => placeName(raw, 'Enter a city.'));
      if (city !== undefined && cities.some(c => nameKey(c.city) === nameKey(city))) details[`${q}.name`] = 'This city is already listed.';
      cities.push({ city, nightlyCents: field(`${q}.nightly`, money()) });
    }
    countryCaps.push({ country, nightlyCents, cities });
  }

  const maxTotalCents = field('trip.maxTotal', money({ optional: true }));

  if (Object.keys(details).length) throw new AppError('invalid_policy', 'Check the highlighted fields.', 422, details);
  return {
    flights: { longHaulMinutes, shortHaul, longHaul, routeOverrides, blockedCarriers },
    hotels: {
      capBasis, defaultNightlyCents, countryCaps, maxStars, minAdvanceDays: hotelAdvance, refundableOnly: hotelRefundable,
    },
    trip: { maxTotalCents },
  };
}

/** Cents as the editor shows dollars: 60000 → "600", 60050 → "600.50". */
function dollarsText(cents) {
  if (cents == null) return '';
  const whole = (cents - (cents % 100)) / 100, part = cents % 100;
  return part ? `${whole}.${String(part).padStart(2, '0')}` : String(whole);
}
/** Tenths as the editor shows a percentage: 200 → "20", 75 → "7.5". */
const pctText = tenths => (tenths == null ? '' : tenths % 10 ? `${(tenths - (tenths % 10)) / 10}.${tenths % 10}` : String(tenths / 10));
const tickText = b => (b ? '1' : '');

function capForm(prefix, cap, out) {
  out[`${prefix}.capMode`] = cap.mode;
  out[`${prefix}.capAmount`] = cap.mode === 'fixed' || cap.mode === 'median_plus' ? dollarsText(cap.amountCents) : '';
  out[`${prefix}.capPct`] = cap.mode === 'median_pct' ? pctText(cap.pctTenths) : '';
  out[`${prefix}.fallback`] = cap.mode === 'median_pct' || cap.mode === 'median_plus' ? dollarsText(cap.fallbackCents) : '';
}

/**
 * The editor's form fields for stored rules (what the editor pre-fills). normalizePolicy(formFromPolicy(r), refs)
 * deep-equals r for any r normalizePolicy produced.
 * @param {import('../types').PolicyRules} rules
 * @returns {import('../types').PolicyForm} every value a string (blockedCarriers: string[])
 */
function formFromPolicy(rules) {
  const out = { longHaulMinutes: String(rules.flights.longHaulMinutes) };
  for (const [prefix, b] of [['short', rules.flights.shortHaul], ['long', rules.flights.longHaul]]) {
    capForm(prefix, b.cap, out);
    out[`${prefix}.maxCabin`] = b.maxCabin;
    out[`${prefix}.minAdvanceDays`] = String(b.minAdvanceDays);
    out[`${prefix}.maxStops`] = b.maxStops == null ? '' : String(b.maxStops);
    out[`${prefix}.refundableOnly`] = tickText(b.refundableOnly);
  }
  rules.flights.routeOverrides.forEach((o, n) => {
    const p = `route.${n}`;
    out[`${p}.from`] = o.from;
    out[`${p}.to`] = o.to;
    out[`${p}.bothWays`] = tickText(o.bothWays);
    capForm(p, o.cap, out);
    out[`${p}.maxCabin`] = o.maxCabin == null ? '' : o.maxCabin;
  });
  out.blockedCarriers = [...rules.flights.blockedCarriers];
  const h = rules.hotels;
  out['hotel.capBasis'] = h.capBasis;
  out['hotel.default'] = dollarsText(h.defaultNightlyCents);
  out['hotel.maxStars'] = h.maxStars == null ? '' : String(h.maxStars);
  out['hotel.minAdvanceDays'] = String(h.minAdvanceDays);
  out['hotel.refundableOnly'] = tickText(h.refundableOnly);
  h.countryCaps.forEach((c, n) => {
    out[`country.${n}.name`] = c.country;
    out[`country.${n}.nightly`] = dollarsText(c.nightlyCents);
    c.cities.forEach((city, m) => {
      out[`country.${n}.city.${m}.name`] = city.city;
      out[`country.${n}.city.${m}.nightly`] = dollarsText(city.nightlyCents);
    });
  });
  out['trip.maxTotal'] = dollarsText(rules.trip.maxTotalCents);
  return out;
}

/** A value with object keys sorted, for comparing (never for storing): JSONB may reorder keys. */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canon(value[k])]));
  return value;
}
const same = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
const copy = x => (x === undefined ? null : structuredClone(x));

/** Lists matched by a natural key: changed entries (by `fields`, or whole), then added, then removed. */
function listChanges(path, before, after, keyOf, label, fields, out) {
  const a = new Map((before || []).map(x => [keyOf(x), x]));
  const b = new Map((after || []).map(x => [keyOf(x), x]));
  for (const [k, x] of b) {
    const at = `${path}[${label(x)}]`;
    if (!a.has(k)) { out.push({ path: at, before: null, after: copy(x) }); continue; }
    if (fields) fields(at, a.get(k), x, out);
    else if (!same(a.get(k), x)) out.push({ path: at, before: copy(a.get(k)), after: copy(x) });
  }
  for (const [k, x] of a) if (!b.has(k)) out.push({ path: `${path}[${label(x)}]`, before: copy(x), after: null });
}

function scalar(path, a, b, out) {
  if (!same(a, b)) out.push({ path, before: copy(a), after: copy(b) });
}

/**
 * The field changes from one version to the next, walking a declared list of paths (never Object.keys
 * order: Postgres JSONB reorders keys). Lists are matched by their natural key: route overrides by
 * 'from-to', countries by name, cities by name. Paths look like 'flights.shortHaul.cap',
 * 'flights.routeOverrides[CAI-LHR]', 'hotels.countryCaps[United Kingdom].cities[London].nightlyCents'.
 * An added list entry has before null, a removed one after null. Blocked carriers compare as a set.
 * @param {import('../types').PolicyRules} before
 * @param {import('../types').PolicyRules} after
 * @returns {import('../types').Change[]} [] when nothing changed
 */
function policyChanges(before, after) {
  const out = [];
  const fa = before.flights, fb = after.flights;
  scalar('flights.longHaulMinutes', fa.longHaulMinutes, fb.longHaulMinutes, out);
  for (const band of ['shortHaul', 'longHaul']) {
    for (const k of ['cap', 'maxCabin', 'minAdvanceDays', 'maxStops', 'refundableOnly']) scalar(`flights.${band}.${k}`, fa[band][k], fb[band][k], out);
  }
  listChanges('flights.routeOverrides', fa.routeOverrides, fb.routeOverrides, o => `${o.from}-${o.to}`, o => `${o.from}-${o.to}`, null, out);
  const ca = [...(fa.blockedCarriers || [])].sort(), cb = [...(fb.blockedCarriers || [])].sort();
  if (!same(ca, cb)) out.push({ path: 'flights.blockedCarriers', before: [...fa.blockedCarriers], after: [...fb.blockedCarriers] });
  const ha = before.hotels, hb = after.hotels;
  for (const k of ['capBasis', 'defaultNightlyCents']) scalar(`hotels.${k}`, ha[k], hb[k], out);
  listChanges('hotels.countryCaps', ha.countryCaps, hb.countryCaps, c => nameKey(c.country), c => c.country, (at, x, y, acc) => {
    scalar(`${at}.nightlyCents`, x.nightlyCents, y.nightlyCents, acc);
    listChanges(`${at}.cities`, x.cities, y.cities, c => nameKey(c.city), c => c.city, (cat, p, q, acc2) => scalar(`${cat}.nightlyCents`, p.nightlyCents, q.nightlyCents, acc2), acc);
  }, out);
  for (const k of ['maxStars', 'minAdvanceDays', 'refundableOnly']) scalar(`hotels.${k}`, ha[k], hb[k], out);
  scalar('trip.maxTotalCents', before.trip.maxTotalCents, after.trip.maxTotalCents, out);
  return out;
}

module.exports = { CAP_MODES, LIMITS, normalizePolicy, formFromPolicy, policyChanges };
