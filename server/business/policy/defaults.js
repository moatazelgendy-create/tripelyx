// The starting travel policy of every new company (plan §E1 "Defaults"), one PolicyRules per tier. Shown as
// "Starting rules suggested by Tripelyx": they are limits a company can change, not price claims. FINAL data
// from Stage 0: team.createCompany writes each tier as version 1 (note DEFAULTS_NOTE), and the policy editor
// starts from them.
//
// - Standard: flights under 6 hours (360 flying minutes) up to the median of the demo fares in the search
//   plus 20% (or $600 when there are fewer than 3 fares to compare), Economy, 7 days ahead, at most 1 stop;
//   6 hours or more: median plus 20% (or $1,500), Premium economy, 14 days ahead, at most 1 stop. Hotels
//   taxes included: $180 a night by default, country caps with city exceptions, up to 4 stars. No trip cap.
// - Director: as Standard, but short haul Premium economy and long haul Business, both median plus 30%;
//   every hotel cap ×1.15 (rounded to whole dollars); up to 5 stars.
// - Executive: as Standard, but short haul Premium economy and long haul Business, both median plus 40%,
//   3 days ahead; every hotel cap ×1.30 (rounded to whole dollars); up to 5 stars.
// Country names are exactly the airport data's (providers/mock/demo-data/flights.js), which is what
// inventory.cityFor() and the hotel rows carry.

/** The note on every version 1, and the banner over untouched rules. */
const DEFAULTS_NOTE = 'Starting rules suggested by Tripelyx';

/** Hotel caps per tier, as a percentage of Standard's (rounded to whole dollars). */
const HOTEL_SCALE_PERCENT = Object.freeze({ standard: 100, director: 115, executive: 130 });

/** [country, nightly cents, [[city, nightly cents], …]] in the order the plan lists them. */
function countryCaps(rows) {
  return rows.map(([country, nightlyCents, cities = []]) => ({
    country, nightlyCents, cities: cities.map(([city, cents]) => ({ city, nightlyCents: cents })),
  }));
}

function band({ pct, fallback, cabin, advance }) {
  return {
    cap: { mode: 'median_pct', pctTenths: pct, fallbackCents: fallback },
    maxCabin: cabin,
    minAdvanceDays: advance,
    maxStops: 1,
    refundableOnly: false,
  };
}

function rules({ short, long, defaultNightly, countries, maxStars }) {
  return {
    flights: {
      longHaulMinutes: 360,
      shortHaul: band(short),
      longHaul: band(long),
      routeOverrides: [],
      blockedCarriers: [],
    },
    hotels: {
      capBasis: 'incl_taxes',
      defaultNightlyCents: defaultNightly,
      countryCaps: countryCaps(countries),
      maxStars,
      minAdvanceDays: 0,
      refundableOnly: false,
    },
    trip: { maxTotalCents: null },
  };
}

const STANDARD = rules({
  short: { pct: 200, fallback: 60000, cabin: 'economy', advance: 7 },
  long: { pct: 200, fallback: 150000, cabin: 'premium', advance: 14 },
  defaultNightly: 18000,
  countries: [
    ['United Arab Emirates', 22000, [['Dubai', 24000]]],
    ['United Kingdom', 26000, [['London', 30000]]],
    ['France', 24000, [['Paris', 28000]]],
    ['Germany', 20000, [['Munich', 22000]]],
    ['Italy', 20000, [['Rome', 22000]]],
    ['Türkiye', 16000, [['Istanbul', 18000]]],
    ['Greece', 17000],
    ['Saudi Arabia', 20000, [['Riyadh', 22000]]],
    ['Egypt', 15000, [['Cairo', 16000]]],
  ],
  maxStars: 4,
});

const DIRECTOR = rules({
  short: { pct: 300, fallback: 60000, cabin: 'premium', advance: 7 },
  long: { pct: 300, fallback: 150000, cabin: 'business', advance: 14 },
  defaultNightly: 20700,
  countries: [
    ['United Arab Emirates', 25300, [['Dubai', 27600]]],
    ['United Kingdom', 29900, [['London', 34500]]],
    ['France', 27600, [['Paris', 32200]]],
    ['Germany', 23000, [['Munich', 25300]]],
    ['Italy', 23000, [['Rome', 25300]]],
    ['Türkiye', 18400, [['Istanbul', 20700]]],
    ['Greece', 19600],
    ['Saudi Arabia', 23000, [['Riyadh', 25300]]],
    ['Egypt', 17300, [['Cairo', 18400]]],
  ],
  maxStars: 5,
});

const EXECUTIVE = rules({
  short: { pct: 400, fallback: 60000, cabin: 'premium', advance: 3 },
  long: { pct: 400, fallback: 150000, cabin: 'business', advance: 3 },
  defaultNightly: 23400,
  countries: [
    ['United Arab Emirates', 28600, [['Dubai', 31200]]],
    ['United Kingdom', 33800, [['London', 39000]]],
    ['France', 31200, [['Paris', 36400]]],
    ['Germany', 26000, [['Munich', 28600]]],
    ['Italy', 26000, [['Rome', 28600]]],
    ['Türkiye', 20800, [['Istanbul', 23400]]],
    ['Greece', 22100],
    ['Saudi Arabia', 26000, [['Riyadh', 28600]]],
    ['Egypt', 19500, [['Cairo', 20800]]],
  ],
  maxStars: 5,
});

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** @type {Readonly<Record<import('../types').Tier, import('../types').PolicyRules>>} */
const DEFAULT_POLICIES = deepFreeze({ standard: STANDARD, director: DIRECTOR, executive: EXECUTIVE });

/**
 * A fresh, mutable copy of one tier's starting rules.
 * @param {import('../types').Tier} tier
 * @returns {import('../types').PolicyRules}
 * @throws {Error} unknown tier (a programming error)
 */
function defaultPolicy(tier) {
  if (!Object.hasOwn(DEFAULT_POLICIES, tier)) throw new Error(`[business] unknown tier ${tier}`);
  return structuredClone(DEFAULT_POLICIES[tier]);
}

module.exports = { DEFAULT_POLICIES, DEFAULTS_NOTE, HOTEL_SCALE_PERCENT, defaultPolicy };
