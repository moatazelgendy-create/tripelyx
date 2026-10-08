const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const { addDays, today } = require('../server/lib/dates');

const quietLog = { error() {}, warn() {}, info() {}, log() {} };

// The suite runs on one fixed day. Demo prices move with the weekday, the season and how far ahead a
// trip leaves, so the trips a test builds on (the pick, its fare, what a hunt finds) would otherwise
// change with the day the suite runs. `clock` starts at FIXED_NOW and keeps moving, so anything that
// measures time passing still sees it pass; `fixedNow` is that moment, held still.
const FIXED_NOW = '2026-10-09T09:00:00.000Z';
const startedAt = Date.now();
const clock = () => new Date(Date.parse(FIXED_NOW) + (Date.now() - startedAt));
const fixedNow = () => new Date(FIXED_NOW);

const DAY = 14;
function sampleQueries(offset = DAY) {
  const d = addDays(today(clock()), offset);
  return {
    hotels: { where: 'New Alamein', checkIn: d, checkOut: addDays(d, 3), guests: 2 },
    flights: { from: 'CAI', to: 'DBB', departDate: d, passengers: 2, cabin: 'economy' },
    cars: { where: 'El Alamein Airport', pickupDate: d, dropoffDate: addDays(d, 4), driverAge: 30 },
    cruises: { guests: 2 },
    yachts: { date: d, duration: 'half_day', guests: 4 },
    transfers: { from: 'El Alamein Airport (DBB)', to: 'New Alamein Downtown', date: d, passengers: 2 },
    activities: { date: d, participants: 2 },
    experiences: { date: d, participants: 2 },
  };
}

async function startApp(env = {}, opts = {}) {
  const config = loadConfig({ APP_ENV: 'development', ...env });
  const built = await createApp(config, { log: quietLog, now: clock, ...opts });
  const server = await new Promise(resolve => { const s = built.app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...built, config, base, close: () => new Promise(r => server.close(r)) };
}

module.exports = { sampleQueries, startApp, quietLog, FIXED_NOW, clock, fixedNow };
