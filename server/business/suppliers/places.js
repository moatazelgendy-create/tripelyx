// The airport data's country names as ISO 3166-1 alpha-2 codes, for LiteAPI's `countryCode` (real-suppliers
// design §3.1). The airport table (providers/mock/demo-data/flights.js, real airports) has 14 airports in these
// 9 countries; a country not listed here has no code, and the hotel adapter then searches nothing.

const ISO2 = Object.freeze({
  Egypt: 'EG',
  'United Arab Emirates': 'AE',
  'Saudi Arabia': 'SA',
  'Türkiye': 'TR',
  Greece: 'GR',
  Italy: 'IT',
  Germany: 'DE',
  France: 'FR',
  'United Kingdom': 'GB',
});

/**
 * @param {unknown} country the airport data's country name ('Egypt')
 * @returns {string|null} 'EG', or null for a country not in the table
 */
function iso2(country) {
  return typeof country === 'string' && Object.prototype.hasOwnProperty.call(ISO2, country) ? ISO2[country] : null;
}

module.exports = { ISO2, iso2 };
