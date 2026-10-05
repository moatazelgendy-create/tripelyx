const { MemoryStore } = require('./MemoryStore');
const { PostgresStore } = require('./PostgresStore');

function createStore(config) {
  if (config.databaseUrl) return new PostgresStore({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  // config.js guarantees this branch is development-only.
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, PostgresStore };
