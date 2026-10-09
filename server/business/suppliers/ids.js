// Stable row ids for supplier offers (real-suppliers design §2.2, §3.2, §3.3). The same itinerary, fare, hotel
// or rate gets the same id in every search, so "the same option, re-found" is recognised days later, and
// supplier ids (Duffel's off_…, LiteAPI's offerId) never leave the suppliers module.
//
//   flight offer  flt_t.<marketing flight numbers joined by '-'>_<YYYYMMDDTHHMM of the first local departure>_<cabin>
//                 flt_t.ZZ1234-ZZ88_20261112T0835_economy (the _<cabin> suffix is the composer's CABIN_SUFFIX)
//   hotel offer   htl_t.<supplier hotel id>             htl_t.lp1897
//   option        a slug of the fare brand or rate, at most 40 characters: slug.slice(0, 31) + '-' + the first 8
//                 hex characters of sha256(the whole slug) when it is longer
// Everything fits dto.ROW_KEY_RE (FINAL): offer part ≤ 160 characters of [A-Za-z0-9_.-], option ≤ 40 of
// [A-Za-z0-9_-]. 'flt_l.' / 'htl_l.' (live) come from source.offerPrefix in round 1b.
const crypto = require('node:crypto');
const { offerPrefix } = require('../source');

const OPTION_MAX = 40;
const OFFER_PART_MAX = 160;
const CABINS = Object.freeze(['economy', 'premium', 'business']);
const SUPPLIER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const sha8 = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 8);

/**
 * Lowercase words joined by '-': "Economy Flex+" → 'economy-flex'. Letters with accents lose them.
 * @param {unknown} text
 * @returns {string} '' when nothing is left
 */
function slug(text) {
  return String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * A slug cut to the option id limit, with a short hash of the whole slug so two long names stay apart.
 * @param {string} full a slug
 * @returns {string} 1 to 40 characters of [a-z0-9-]
 */
function fit(full, max = OPTION_MAX) {
  const s = full || 'fare';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 9).replace(/-+$/, '')}-${sha8(s)}`;
}

/**
 * A flight option id: the fare brand's slug, else the cabin's marketing name slug with condition flags
 * (r/c then 1 allowed, 0 not allowed, x unknown): 'basic', 'economy-r0c1'.
 * @param {{ brand?: string|null, marketingName?: string|null, cabin: string, refundAllowed?: boolean|null, changeAllowed?: boolean|null }} f
 * @returns {string}
 */
function flightOptionId({ brand = null, marketingName = null, cabin, refundAllowed = null, changeAllowed = null }) {
  const b = slug(brand);
  if (b) return fit(b);
  const flag = v => (v === true ? '1' : v === false ? '0' : 'x');
  return fit(`${slug(marketingName) || slug(cabin) || 'fare'}-r${flag(refundAllowed)}c${flag(changeAllowed)}`);
}

/**
 * A hotel option id: the rate's name, its board type and R (refundable) or N: 'standard-room-ro-r'.
 * @param {{ rateName: string, boardType?: string|null, refundable: boolean }} r
 * @returns {string}
 */
function hotelOptionId({ rateName, boardType = null, refundable }) {
  return fit([slug(rateName) || 'room', slug(boardType) || 'board', refundable ? 'r' : 'n'].join('-'));
}

/**
 * A flight offer (itinerary) id.
 * @param {'sandbox'|'live'} mode
 * @param {{ flightNumbers: string[], firstDepartLocal: string, cabin: string }} it firstDepartLocal 'YYYY-MM-DDTHH:MM'
 * @returns {string|null} null when the parts can't make an id (a flight number with no letters or digits)
 */
function flightOfferId(mode, { flightNumbers, firstDepartLocal, cabin }) {
  if (!CABINS.includes(cabin) || !Array.isArray(flightNumbers) || !flightNumbers.length) return null;
  const nums = flightNumbers.map(n => String(n).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (nums.some(n => !n)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(firstDepartLocal));
  if (!m) return null;
  const prefix = offerPrefix('flight', mode);
  let body = `${nums.join('-')}_${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}_${cabin}`;
  const room = OFFER_PART_MAX - (prefix.length - 'flt_'.length);
  if (body.length > room) {
    const tail = `_${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}_${cabin}`;
    const head = nums.join('-');
    body = `${head.slice(0, room - tail.length - 9)}-${sha8(head)}${tail}`;
  }
  return prefix + body;
}

/**
 * A hotel offer id.
 * @param {'sandbox'|'live'} mode
 * @param {unknown} hotelId the supplier's hotel id
 * @returns {string|null} null for an id that is not 1 to 64 of [A-Za-z0-9_-]
 */
function hotelOfferId(mode, hotelId) {
  if (typeof hotelId !== 'string' || !SUPPLIER_ID_RE.test(hotelId)) return null;
  return offerPrefix('hotel', mode) + hotelId;
}

module.exports = { slug, fit, flightOptionId, hotelOptionId, flightOfferId, hotelOfferId, OPTION_MAX };
