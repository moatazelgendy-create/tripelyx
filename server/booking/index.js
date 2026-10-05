const { MemoryStore } = require('./MemoryStore');
const { PostgresStore } = require('./PostgresStore');

function createStore(config) {
  if (config.databaseUrl === 'memory') return new MemoryStore();
  if (config.databaseUrl) return new PostgresStore({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  // config.js guarantees these in-memory branches never run in production.
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, PostgresStore };
