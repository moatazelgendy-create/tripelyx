// Cancellation cutoffs: when each part of a trip stops being free to cancel. Every date here is a
// supplier's stated hours applied to the trip's own dates; nothing is estimated and nothing counts
// down. A cutoff appears only when its rule and its date are both known. The booking engine refunds
// by these same cutoffs, so what a page says and what a cancellation pays never disagree.
//
// Travel dates are plain 'YYYY-MM-DD' strings with no time zone (see lib/dates), so a cutoff is
// measured from midnight UTC at the start of the departure day. That is at or before any real
// departure, check-in or pickup, so a cutoff shown here is never later than the supplier's rule.
const { daysBetween, today } = require('../lib/dates');

const HOUR = 3600000;
const FULL_REFUND_HOURS = 24;     // the 24-hour window after booking (US rule for flights, matched by every part)
const FULL_REFUND_MIN_DAYS = 7;   // ...which only applies when the booking is made this far ahead

// Suppliers state short windows in hours and long ones in days: 24 hours, 72 hours, 7 days.
// Suppliers state short windows in hours and long ones in days: 24 hours, 72 hours, 7 days.
const hoursText = h => (h >= 72 && h % 24 === 0 ? `${h / 24} days` : `${h} hours`);
const stated = x => (x && Number.isFinite(x.freeCancelHours) ? x.freeCancelHours : null);
const UNVERIFIED = 'free-cancellation window not stated by the supplier: needs verification';

// Does the 24-hour full-refund window apply to a booking made at `at`? The rule is about when the
// booking is made (at least 7 days before departure), so it is judged on the booking day.
function fullRefundApplies(t, at) {
  return daysBetween(today(at), t.spec.depart) >= FULL_REFUND_MIN_DAYS;
}

// The cutoffs of a trip. `bookedAt` (ISO instant) adds the full-refund window of a booking made then.
// A refundable part whose supplier states no hours gets no cutoff and is marked unverified: we never
// invent a deadline, and the refund treats it as closed outside the full-refund window.
function cutoffs(t, { bookedAt = null } = {}) {
  const start = Date.parse(`${t.spec.depart}T00:00:00Z`);
  const before = hours => new Date(start - hours * HOUR).toISOString();
  const part = (key, component, hours, when) => (hours === null
    ? { key, component, cutoff: null, unverified: true, rule: UNVERIFIED }
    : { key, component, cutoff: before(hours), rule: `${hoursText(hours)} before ${when}` });
  const f = t.flight, h = t.hotel;
  const items = [
    f.refundable ? part('flights', 'Flights', stated(f), 'departure') : { key: 'flights', component: 'Flights', cutoff: null, rule: `the ${f.name} fare is not refundable after the first 24 hours` },
    h.refundable ? part('hotel', 'Hotel', stated(h), 'check-in') : { key: 'hotel', component: 'Hotel', cutoff: null, rule: 'non-refundable rate' },
    ...(t.activities || []).map(a => part(`activity:${a.id}`, a.name, stated(a), 'the activity, counted from the day you arrive because its day is set after booking')),
    ...(t.transfer ? [part('transfer', 'Airport transfer', stated(t.transfer), 'your first pickup')] : []),
    { key: 'service', component: 'Service fee', cutoff: null, rule: 'refunded only inside the full-refund window' },
  ];
  const booked = bookedAt ? Date.parse(bookedAt) : NaN;
  // Shown to the minute, so enforced to the minute (floored: never later than the rule).
  const fullRefundUntil = Number.isFinite(booked) && fullRefundApplies(t, new Date(booked)) ? new Date(Math.floor((booked + FULL_REFUND_HOURS * HOUR) / 60000) * 60000).toISOString() : null;
  return { items, fullRefundUntil };
}

// Still free to cancel at `now`?
function isOpen(item, now) {
  return !!(item && item.cutoff && now.getTime() < Date.parse(item.cutoff));
}

// The earliest cutoff still ahead, or null.
function nextCutoff(items, now) {
  return items.filter(it => isOpen(it, now)).sort((a, b) => Date.parse(a.cutoff) - Date.parse(b.cutoff))[0] || null;
}

module.exports = { cutoffs, isOpen, nextCutoff, fullRefundApplies, hoursText, FULL_REFUND_HOURS, FULL_REFUND_MIN_DAYS };
