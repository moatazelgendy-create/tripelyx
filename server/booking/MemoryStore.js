// In-memory store for local development and tests. Same interface as PostgresStore; data is lost on
// restart. config.js only allows it when APP_ENV=development and no DATABASE_URL is set.
const clone = v => (v === undefined ? undefined : structuredClone(v));

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.quotes = new Map();
    this.bookings = new Map();
    this.refs = new Map();
    this.intents = new Map();
    this.leads = [];
    this.records = new Map();
  }

  async init() {}
  async close() {}

  async saveQuote(q) { this.quotes.set(q.id, clone(q)); return q; }
  async getQuote(id) { return clone(this.quotes.get(id)) || null; }

  async createBooking(b) {
    if (this.refs.has(b.ref)) throw new Error('duplicate booking ref');
    this.bookings.set(b.id, clone(b));
    this.refs.set(b.ref, b.id);
    return b;
  }

  async getBooking(id) { return clone(this.bookings.get(id)) || null; }
  async getBookingByRef(ref) { const id = this.refs.get(ref); return id ? this.getBooking(id) : null; }

  // Compare-and-set on status, so two concurrent pay/cancel calls can't both win.
  async updateBooking(id, expectedStatus, patch) {
    const cur = this.bookings.get(id);
    if (!cur || (expectedStatus && cur.status !== expectedStatus)) return null;
    const next = { ...cur, ...clone(patch), updatedAt: new Date().toISOString() };
    this.bookings.set(id, next);
    return clone(next);
  }

  async savePaymentIntent(i) { this.intents.set(i.id, clone(i)); return i; }
  async getPaymentIntent(id) { return clone(this.intents.get(id)) || null; }

  async savePartnerLead(lead) { this.leads.push(clone(lead)); return lead; }
  async listPartnerLeads({ limit = 500 } = {}) { return this.leads.slice(-limit).reverse().map(clone); }

  // Newest first.
  async listBookings({ userId, limit = 500 } = {}) {
    return [...this.bookings.values()].filter(b => !userId || b.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit).map(clone);
  }

  // Generic records (accounts, saved trips, analytics events, settings, support messages, …): a kind,
  // an id, an optional owner and a JSON document.
  async putRecord(kind, id, data, { userId = null } = {}) {
    const key = `${kind}:${id}`;
    const prev = this.records.get(key);
    this.records.set(key, { kind, id, userId: userId ?? (prev && prev.userId) ?? null, data: clone(data), createdAt: prev ? prev.createdAt : new Date().toISOString(), seq: prev ? prev.seq : (this.seq = (this.seq || 0) + 1) });
    return data;
  }
  async getRecord(kind, id) { const r = this.records.get(`${kind}:${id}`); return r ? clone(r.data) : null; }
  async deleteRecord(kind, id) { return this.records.delete(`${kind}:${id}`); }
  async listRecords(kind, { userId, limit = 1000, since } = {}) {
    return [...this.records.values()].filter(r => r.kind === kind && (!userId || r.userId === userId) && (!since || r.createdAt >= since))
      .sort((a, b) => b.seq - a.seq).slice(0, limit).map(r => clone(r.data));
  }
}

module.exports = { MemoryStore };
