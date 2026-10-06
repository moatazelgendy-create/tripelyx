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
const DEFAULT_EXTRA_HOURS = 24;   // experiences and transfers without stated hours: the terms every demo supplier states

// Suppliers state short windows in hours and long ones in days: 24 hours, 72 hours, 7 days.
const hoursText = h => (h >= 72 && h % 24 === 0 ? `${h / 24} days` : `${h} hours`);
const stated = (x, fallback) => (x && Number.isFinite(x.freeCancelHours) ? x.freeCancelHours : fallback);

// Does the 24-hour full-refund window apply to a booking made at `at`?
function fullRefundApplies(t, at) {
  return daysBetween(today(at), t.spec.depart) >= FULL_REFUND_MIN_DAYS;
}

// The cutoffs of a trip. `bookedAt` (ISO instant) adds the full-refund window of a booking made then.
function cutoffs(t, { bookedAt = null } = {}) {
  const start = Date.parse(`${t.spec.depart}T00:00:00Z`);
  const before = hours => new Date(start - hours * HOUR).toISOString();
  const f = t.flight, h = t.hotel;
  const items = [
    f.refundable
      ? { key: 'flights', component: 'Flights', cutoff: before(stated(f, 0)), rule: `${hoursText(stated(f, 0))} before departure` }
      : { key: 'flights', component: 'Flights', cutoff: null, rule: `the ${f.name} fare is not refundable after the first 24 hours` },
    h.refundable
      ? { key: 'hotel', component: 'Hotel', cutoff: before(stated(h, 0)), rule: `${hoursText(stated(h, 0))} before check-in` }
      : { key: 'hotel', component: 'Hotel', cutoff: null, rule: 'non-refundable rate' },
    ...(t.activities || []).map(a => ({ key: `activity:${a.id}`, component: a.name, cutoff: before(stated(a, DEFAULT_EXTRA_HOURS)), rule: `${hoursText(stated(a, DEFAULT_EXTRA_HOURS))} before the activity, counted from the day you arrive because its day is set after booking` })),
    ...(t.transfer ? [{ key: 'transfer', component: 'Airport transfer', cutoff: before(stated(t.transfer, DEFAULT_EXTRA_HOURS)), rule: `${hoursText(stated(t.transfer, DEFAULT_EXTRA_HOURS))} before your first pickup` }] : []),
    { key: 'service', component: 'Service fee', cutoff: null, rule: 'refunded only inside the full-refund window' },
  ];
  const booked = bookedAt ? Date.parse(bookedAt) : NaN;
  const fullRefundUntil = Number.isFinite(booked) && fullRefundApplies(t, new Date(booked)) ? new Date(booked + FULL_REFUND_HOURS * HOUR).toISOString() : null;
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
