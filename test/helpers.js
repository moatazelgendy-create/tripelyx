const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const { addDays, today } = require('../server/lib/dates');

const quietLog = { error() {}, warn() {}, info() {}, log() {} };

const DAY = 14;
function sampleQueries(offset = DAY) {
  const d = addDays(today(), offset);
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
  const built = await createApp(config, { log: quietLog, ...opts });
  const server = await new Promise(resolve => { const s = built.app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...built, config, base, close: () => new Promise(r => server.close(r)) };
}

module.exports = { sampleQueries, startApp, quietLog };
