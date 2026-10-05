// All amounts are integer minor units (cents) — never floats — from the provider adapters through
// the engine, the payment processor and the database. Formatting happens only at the edges.
function toMinor(major) {
  return Math.round(Number(major) * 100);
}

function sumLines(lines) {
  return lines.reduce((acc, l) => acc + l.amount, 0);
}

function percentOf(amount, percent) {
  return Math.round((amount * percent) / 100);
}

function format(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
}

module.exports = { toMinor, sumLines, percentOf, format };
