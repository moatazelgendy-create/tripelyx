// Sorting and filtering of normalized search results (the "Sort by" menu and filter sidebar).
// Works only on the normalized Offer shape, so every vertical and every supplier gets the same
// filters without the UI knowing where the inventory came from.

const SORTS = {
  recommended: { label: 'Recommended', compare: null },
  price_asc: { label: 'Price: low to high', compare: (a, b) => a.fromPrice.amount - b.fromPrice.amount },
  price_desc: { label: 'Price: high to low', compare: (a, b) => b.fromPrice.amount - a.fromPrice.amount },
  rating: { label: 'Guest rating', compare: (a, b) => ratingOf(b) - ratingOf(a) || a.fromPrice.amount - b.fromPrice.amount },
};

const RATING_STEPS = [
  { min: 4.5, label: 'Wonderful' },
  { min: 4, label: 'Very good' },
  { min: 3.5, label: 'Good' },
];

function ratingOf(offer) {
  return offer.rating ? offer.rating.score : 0;
}

function ratingWord(score) {
  const step = RATING_STEPS.find(s => score >= s.min);
  return step ? step.label : 'Rated';
}

function isFreeCancel(offer) {
  return offer.cancellation && offer.cancellation.type !== 'non_refundable';
}

// Round a price (minor units) up to a "nice" major-unit ceiling for the price buckets.
function niceCeil(minor) {
  const major = minor / 100;
  const step = major <= 100 ? 25 : major <= 500 ? 50 : major <= 2000 ? 250 : 1000;
  return Math.ceil(major / step) * step;
}

function priceBuckets(offers) {
  const prices = offers.map(o => o.fromPrice.amount).sort((a, b) => a - b);
  if (prices.length < 3) return [];
  const pick = q => niceCeil(prices[Math.min(prices.length - 1, Math.floor(q * prices.length))]);
  const out = [];
  for (const v of [pick(0.25), pick(0.5), pick(0.75)]) if (!out.includes(v) && v * 100 < prices[prices.length - 1]) out.push(v);
  return out.map(max => ({ max, count: prices.filter(p => p <= max * 100).length }));
}

function parseRefine(query = {}) {
  const sort = SORTS[query.sort] ? query.sort : 'recommended';
  const minRating = Number(query.minRating);
  const maxPrice = Number(query.maxPrice);
  return {
    sort,
    freeCancel: query.freeCancel === '1',
    minRating: RATING_STEPS.some(s => s.min === minRating) ? minRating : null,
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null,
  };
}

function refine(offers, refineQuery) {
  const r = refineQuery;
  const facets = {
    freeCancel: offers.filter(isFreeCancel).length,
    ratings: offers.some(o => o.rating) ? RATING_STEPS.map(s => ({ ...s, count: offers.filter(o => ratingOf(o) >= s.min).length })) : [],
    prices: priceBuckets(offers),
    unit: offers[0] ? offers[0].fromPrice.unit : null,
    currency: offers[0] ? offers[0].fromPrice.currency : 'USD',
  };
  let list = offers.filter(o =>
    (!r.freeCancel || isFreeCancel(o)) &&
    (r.minRating === null || ratingOf(o) >= r.minRating) &&
    (r.maxPrice === null || o.fromPrice.amount <= r.maxPrice * 100));
  const cmp = SORTS[r.sort].compare;
  if (cmp) list = [...list].sort(cmp);
  return { offers: list, total: offers.length, facets, active: r.freeCancel || r.minRating !== null || r.maxPrice !== null };
}

module.exports = { refine, parseRefine, ratingWord, SORTS, RATING_STEPS };
