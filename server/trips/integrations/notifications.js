// Email/SMS notifications. Until a real provider is connected (NOTIFY_PROVIDER), messages go to an
// outbox in the database that the admin control center shows, marked as not sent. Nothing here ever
// contacts a real person.
const { id } = require('../../lib/ids');

class OutboxNotifier {
  constructor({ store, log = console, now = () => new Date() }) {
    this.kind = 'outbox';
    this.store = store;
    this.log = log;
    this.now = now;
  }

  async send({ to, channel = 'email', subject, body, audience = 'customer', ref = null }) {
    const msg = { id: id('msg'), to, channel, subject, body, audience, ref, status: 'not_sent_outbox', createdAt: this.now().toISOString() };
    await this.store.putRecord('outbox', msg.id, msg);
    return msg;
  }
}

const PROVIDERS = {};

function createNotifier(config, deps) {
  const name = config.trips.providers.notifications;
  if (name === 'outbox') return new OutboxNotifier(deps);
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`NOTIFY_PROVIDER "${name}" is not registered in server/trips/integrations/notifications.js`);
  return factory(config, deps);
}

module.exports = { createNotifier, OutboxNotifier };
