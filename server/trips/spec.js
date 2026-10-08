// A trip is fully described by a compact, URL-safe token, so every trip page is a shareable link and
// the server can re-price it from scratch at any time (results, customizer, price check, checkout):
//   <dest>~<airport>~<depart>~<nights>~<travelers><who>~<hotel>~<flight>~<bags><transfer>~<activities|->
// e.g. cancun~SFO~2026-11-10~5~2c~cun-2~nonstop~01~cun-a2.cun-a4
const { isIsoDate } = require('../lib/dates');
const { AppError } = require('../lib/errors');

const WHO = { s: 'solo', c: 'couple', f: 'family', g: 'friends' };
const WHO_CODE = Object.fromEntries(Object.entries(WHO).map(([k, v]) => [v, k]));
const SAFE = /^[a-z0-9-]{1,40}$/;

function encodeSpec(s) {
  const acts = s.activities && s.activities.length ? [...s.activities].sort().join('.') : '-';
  return [s.dest, s.from, s.depart, s.nights, `${s.travelers}${WHO_CODE[s.who] || 'c'}`, s.hotel, s.flight, `${s.bags ? 1 : 0}${s.transfer ? 1 : 0}`, acts].join('~');
}

function decodeSpec(token) {
  const bad = () => new AppError('trip_not_found', 'We couldn’t read that trip link. Please build the trip again.', 404);
  const parts = String(token || '').slice(0, 300).split('~');
  if (parts.length !== 9) throw bad();
  const [dest, from, depart, nights, tw, hotel, flight, bt, acts] = parts;
  const m = /^(\d{1,2})([scfg])$/.exec(tw);
  if (!SAFE.test(dest) || !/^[A-Z]{3}$/.test(from) || !isIsoDate(depart) || !/^\d{1,2}$/.test(nights) || !m
    || !SAFE.test(hotel) || !SAFE.test(flight) || !/^[01]{2}$/.test(bt)) throw bad();
  const activities = acts === '-' ? [] : acts.split('.');
  if (activities.length > 6 || activities.some(a => !SAFE.test(a))) throw bad();
  const spec = {
    dest, from, depart, nights: Number(nights), travelers: Number(m[1]), who: WHO[m[2]],
    hotel, flight, bags: bt[0] === '1', transfer: bt[1] === '1', activities: [...new Set(activities)].sort(),
  };
  if (spec.nights < 1 || spec.nights > 21 || spec.travelers < 1 || spec.travelers > 9) throw bad();
  return spec;
}

module.exports = { encodeSpec, decodeSpec, WHO };
