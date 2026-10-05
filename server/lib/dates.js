// Travel dates are plain 'YYYY-MM-DD' strings (no time zone): a check-in on the 15th is the 15th
// wherever the traveler is. Arithmetic is done in UTC so DST never shifts a day.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function hoursUntil(dateStr, now = new Date()) {
  return (Date.parse(`${dateStr}T00:00:00Z`) - now.getTime()) / 3600000;
}

module.exports = { isIsoDate, addDays, daysBetween, today, hoursUntil };
