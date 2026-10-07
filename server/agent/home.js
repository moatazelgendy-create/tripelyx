// The agent's home after booking: what today is, what comes next, the trip's status, the money
// left, the next reservation and the actions that matter. Every line comes from the booking's own
// facts and from cutoffs the suppliers state; nothing here is a countdown, a nudge or a guess, and
// what only the traveler can check is marked as such.
const { plural, longDate, money } = require('../views/trips/common');
const leaks = require('../trips/leaks');

const STATUS_WORDS = { confirmed: 'Confirmed', pending_payment: 'Awaiting payment', confirming: 'Confirming with suppliers', pending_supplier: 'Awaiting a supplier', partially_confirmed: 'Partly confirmed', cancelled: 'Cancelled', refunded: 'Refunded', failed: 'Failed' };

function bookingHome(b, { now = new Date(), preview = null, origin = null } = {}) {
  const t = b.quote.trip;
  const spec = t.spec;
  const todayIso = now.toISOString().slice(0, 10);
  const days = (a, c) => Math.round((Date.parse(`${c}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const day = iso => longDate(String(iso).slice(0, 10));
  const toGo = days(todayIso, spec.depart);
  const back = t.flight.return;
  const cancelled = b.status === 'cancelled' || b.status === 'refunded';

  let today;
  if (cancelled) today = { title: 'This trip was cancelled', detail: b.refundAmount !== null && b.refundAmount !== undefined ? `${money(b.refundAmount)} refunded` : 'The refund is on the booking page' };
  else if (toGo > 0) today = { title: `${plural(toGo, 'day')} to departure`, detail: `Leaving ${day(spec.depart)} from ${origin ? origin.city : spec.from}` };
  else if (todayIso <= back) today = { title: `Day ${-toGo + 1} of ${days(spec.depart, back) + 1} in ${t.dest.name}`, detail: `Home ${day(back)}` };
  else today = { title: 'Trip completed', detail: `Back home ${day(back)}` };

  // Next: the earliest dated thing ahead, from the booking and the suppliers' stated cutoffs.
  const ahead = [];
  if (!cancelled) {
    if (b.status === 'pending_payment' && b.paymentDueAt) ahead.push({ when: String(b.paymentDueAt).slice(0, 10), title: 'Payment due', detail: `Pay by ${day(b.paymentDueAt)} or the hold ends` });
    if (preview && preview.allowed) {
      if (preview.freeWindowOpen && preview.fullRefundUntil) ahead.push({ when: String(preview.fullRefundUntil).slice(0, 10), title: 'Full-refund window closes', detail: `Cancel by ${day(preview.fullRefundUntil)} (UTC) for ${money(preview.refundAmount)} back` });
      else if (preview.nextCutoff) ahead.push({ when: String(preview.nextCutoff.cutoff).slice(0, 10), title: `Free cancellation of ${preview.nextCutoff.component.toLowerCase()} ends`, detail: `By ${day(preview.nextCutoff.cutoff)} (UTC), as the supplier states it` });
    }
    if (toGo > 0) ahead.push({ when: spec.depart, title: `Departure with ${t.flight.airline}`, detail: `${day(spec.depart)} · ${t.flight.stops ? plural(t.flight.stops, 'stop') : 'nonstop'} · online check-in usually opens 24 hours before (general guidance)` });
    else if (todayIso <= back) ahead.push({ when: back, title: 'Flight home', detail: `${day(back)} from ${t.dest.airport}` });
  }
  ahead.sort((a, c) => (a.when < c.when ? -1 : a.when > c.when ? 1 : 0));
  const next = ahead.find(a => a.when >= todayIso) || ahead[0] || { title: 'Nothing scheduled', detail: cancelled ? 'The trip is cancelled' : 'Your trip is done' };

  const comps = b.components || [];
  const confirmed = comps.filter(c => c.status === 'confirmed').length;
  const open = comps.filter(c => c.status !== 'confirmed');
  const status = {
    title: STATUS_WORDS[b.status] || String(b.status).replace(/_/g, ' '),
    detail: comps.length ? `${confirmed} of ${plural(comps.length, 'part')} confirmed${open.length ? `: ${open.map(c => `${c.name} ${String(c.status).replace(/_/g, ' ')}`).join(', ')}` : ''}` : b.status === 'pending_payment' ? 'Nothing is booked with suppliers until payment' : `Trip ID ${b.ref}`,
  };

  const bud = (b.quote && b.quote.budget) || null;
  const paid = b.payment && b.payment.amount ? b.payment.amount : b.status === 'pending_payment' ? 0 : b.total;
  const remaining = bud && bud.budget
    ? { title: money(Math.max(0, bud.budget - b.total)), detail: `of your ${money(bud.budget)} after the ${money(b.total)} booking${bud.keep ? `; the ${money(bud.keep)} you protected for the destination stays yours` : ''}` }
    : { title: paid ? `${money(paid)} paid` : `${money(b.total)} due`, detail: 'No budget was set on this booking, so there is no "left over" to show' };

  // Next reservation: the earliest part ahead, with its date.
  const res = [];
  if (!cancelled) {
    res.push({ when: spec.depart, title: `${t.flight.airline} to ${t.dest.name}`, detail: `${day(spec.depart)} · ${t.flight.name} fare · ${t.flight.stops ? plural(t.flight.stops, 'stop') : 'nonstop'}` });
    res.push({ when: spec.depart, title: `Check in at ${t.hotel.name}`, detail: `${day(spec.depart)} · ${plural(spec.nights, 'night')} · times on your voucher` });
    if (t.transfer) res.push({ when: spec.depart, title: 'Airport transfer', detail: `${day(spec.depart)} · meeting instructions come with your confirmation` });
    for (const a of t.activities) res.push({ when: spec.depart, title: a.name, detail: 'Date and meeting point on the voucher that comes with your confirmation' });
    res.push({ when: back, title: `${t.flight.airline} home`, detail: `${day(back)} from ${t.dest.airport}` });
  }
  const reservation = res.find(r => r.when >= todayIso) || res[res.length - 1] || { title: 'None', detail: '' };

  // Important actions: each from a fact of this trip, marked as known or as something only the traveler can check.
  const actions = [];
  if (b.status === 'pending_payment') actions.push({ status: 'check', text: `Pay to confirm: nothing is booked with suppliers until then${b.paymentDueAt ? `, and the hold ends ${day(b.paymentDueAt)}` : ''}.` });
  if (b.status === 'partially_confirmed' || b.status === 'pending_supplier') actions.push({ status: 'check', text: 'A part is not confirmed yet: our team is on it and will contact you about your options.' });
  if (!cancelled && toGo > 0) {
    actions.push(t.internationalTrip
      ? { status: 'check', text: `${t.dest.country} is international: every traveler needs a valid passport, and entry rules depend on nationality. Only you can check yours.` }
      : { status: 'info', text: 'A domestic flight: a REAL ID-compliant licence or a passport at security, as general guidance.' });
    if (preview && preview.allowed && preview.nextCutoff) actions.push({ status: 'ready', text: `Free cancellation of ${preview.nextCutoff.component.toLowerCase()} ends ${day(preview.nextCutoff.cutoff)} (UTC); after that each part follows its own terms.` });
    if (preview && preview.deadlines && preview.deadlines.some(d => d.unverified)) actions.push({ status: 'check', text: `A supplier states no cutoff for ${preview.deadlines.filter(d => d.unverified).map(d => d.component.toLowerCase()).join(', ')}: those terms need verification before you rely on them.` });
    if (!(t.flight.checkedBagIncluded || spec.bags)) actions.push({ status: 'ready', text: `No checked bag is in the price (${t.flight.carryOn ? 'one carry-on' : 'a personal item'} per traveler is). Add one before you fly if you need it.` });
    if (!t.transfer) actions.push({ status: 'check', text: 'No airport transfer is in the price; the fare from the airport is not something we can quote (needs verification).' });
  }
  // The saver's victory: what the traveler gave as a maximum, what the trip cost, what they kept, and
  // which of their stated asks the trip's facts meet (an unmet ask is listed, never hidden; an ask
  // never stated is not listed). Only when the quote carried a maximum. The asks are read exactly as
  // the quote stores them (`budget.asks`, with the rules nested or flat): the service writes a
  // destination there only when the traveler named one, so nothing is synthesized here from the booked
  // trip's own facts. The money the traveler protected (`budget.keep`) is part of what they gave: the
  // engine says the whole number and the booking's share apart, as the booking page does.
  const asks = (bud && bud.asks) || {};
  const victory = bud && bud.budget && t.flight && t.hotel && t.hotel.features ? leaks.victory({ max: bud.budget, trip: t, asks: { ...asks, ...(asks.rules || {}) }, reserve: bud.keep || 0 }) : null;
  return { ref: b.ref, cancelled, toGo, today, next, status, remaining, reservation, actions, paid, total: b.total, bookingHref: `/booking/${b.ref}`, victory };
}

module.exports = { bookingHome };
