const { format: money } = require('../lib/money');

const UNIT_LABEL = {
  night: 'per night', passenger: 'per passenger', day: 'per day', guest: 'per guest', charter: 'per charter',
  vehicle: 'per vehicle', seat: 'per seat', ticket: 'per person',
};

function date(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso.length === 7 ? `${iso}-01T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(d);
}

function month(iso) {
  return date(iso, { month: 'long', year: 'numeric' });
}

function minutes(m) {
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}h${r ? ` ${String(r).padStart(2, '0')}m` : ''}` : `${r}m`;
}

function querySummary(vertical, q) {
  switch (vertical) {
    case 'hotels': return `${q.where} · ${date(q.checkIn, { day: 'numeric', month: 'short' })} – ${date(q.checkOut)} · ${q.guests} guest${q.guests > 1 ? 's' : ''}`;
    case 'flights': return `${q.from} → ${q.to} · ${date(q.departDate)} · ${q.passengers} passenger${q.passengers > 1 ? 's' : ''} · ${q.cabin}`;
    case 'cars': return `${q.where} · ${date(q.pickupDate, { day: 'numeric', month: 'short' })} – ${date(q.dropoffDate)}`;
    case 'cruises': return `${q.where || 'All regions'}${q.month ? ` · ${month(q.month)}` : ''} · ${q.guests} guest${q.guests > 1 ? 's' : ''}`;
    case 'yachts': return `${q.where || 'All marinas'} · ${date(q.date)} · ${q.guests} guests`;
    case 'transfers': return `${q.from} → ${q.to} · ${date(q.date)} · ${q.passengers} passenger${q.passengers > 1 ? 's' : ''}`;
    default: return `${q.where || 'All destinations'} · ${date(q.date)} · ${q.participants} participant${q.participants > 1 ? 's' : ''}`;
  }
}

const STATUS_LABEL = {
  pending_payment: 'Awaiting payment', confirming: 'Confirming', pending_supplier: 'Awaiting partner confirmation',
  confirmed: 'Confirmed', cancelling: 'Cancelling', cancelled: 'Cancelled', expired: 'Expired', failed: 'Not confirmed',
  partially_confirmed: 'Partially confirmed', refund_pending: 'Refund pending', refunded: 'Refunded',
};

module.exports = { money, date, month, minutes, querySummary, UNIT_LABEL, STATUS_LABEL };
