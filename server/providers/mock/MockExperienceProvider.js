// ActivityProvider and ExperienceProvider backed by demo inventory. The two verticals share a catalogue
// shape (dated, time-slotted, ticketed), so one adapter class serves both, filtered by `kind`. Ticket
// types are the options; the time slot is a required selection at quote time.
const DATA = require('./demo-data/experiences');
const { BaseMockProvider, media, cancellationFromDays, line, matchesText } = require('./BaseMockProvider');
const { toMinor, percentOf } = require('../../lib/money');
const { AppError } = require('../../lib/errors');

class MockExperienceProvider extends BaseMockProvider {
  constructor({ vertical = 'experiences', ...opts } = {}) {
    super({ vertical, name: vertical === 'activities' ? 'MockActivityProvider' : 'MockExperienceProvider', ...opts });
    this.kind = vertical === 'activities' ? 'activity' : 'experience';
  }

  slots(item, date) {
    return item.slots.map(time => {
      // Some slots are partly sold; a few are full.
      const taken = Math.floor(this.rand(item.code, date, time) * item.capacity * 1.15);
      return { time, capacity: item.capacity, remaining: Math.max(0, item.capacity - taken) };
    });
  }

  buildOffers(query, { offerId } = {}) {
    return DATA.items
      .filter(i => i.kind === this.kind)
      .filter(i => !offerId || `${this.kind === 'activity' ? 'act' : 'exp'}_${i.code}` === offerId)
      .filter(i => offerId || matchesText([i.name, i.city, i.category, 'north coast', 'egypt'], query.where))
      .map(i => this.toOffer(i, query))
      .filter(o => offerId || o.details.slots.some(s => s.remaining >= query.participants));
  }

  toOffer(i, query) {
    const id = `${this.kind === 'activity' ? 'act' : 'exp'}_${i.code}`;
    const slots = this.slots(i, query.date);
    const open = slots.some(s => s.remaining > 0);
    const options = i.tickets.map(t => ({
      id: t.code, name: t.name, description: i.includes.join(' · '),
      price: { amount: toMinor(t.usd), currency: 'USD' },
      total: { amount: toMinor(t.usd) * query.participants, currency: 'USD' },
      capacity: i.capacity, available: open, features: i.includes,
    }));
    const hours = i.duration_min >= 60 ? `${Math.round(i.duration_min / 6) / 10} hours` : `${i.duration_min} min`;
    return {
      id, vertical: this.vertical, provider: this.name, demo: true,
      title: i.name, subtitle: `${i.category} · ${i.city}`, description: i.summary,
      location: { name: i.meeting.name, city: i.city },
      media: [media(i.scene, id, i.name)],
      rating: { score: i.rating, count: i.reviews },
      badges: slots.some(s => s.remaining > 0 && s.remaining <= 4) ? ['Selling fast'] : [],
      fromPrice: { amount: Math.min(...options.map(o => o.price.amount)), currency: 'USD', unit: 'ticket' },
      attributes: [
        { label: 'Duration', value: hours },
        { label: 'Languages', value: i.languages.join(', ') },
        { label: 'Group size', value: `up to ${i.capacity}` },
      ],
      options,
      cancellation: cancellationFromDays(DATA.cancel),
      details: {
        category: i.category, date: query.date, durationMinutes: i.duration_min,
        meetingPoint: i.meeting, slots, languages: i.languages, includes: i.includes,
      },
    };
  }

  validateSelection(offer, option, query, selection) {
    const slot = offer.details.slots.find(s => s.time === selection.slot);
    if (!slot) throw new AppError('slot_required', 'Choose a start time.', 400);
    if (slot.remaining < query.participants) throw new AppError('slot_full', `Only ${slot.remaining} place${slot.remaining === 1 ? '' : 's'} left at ${slot.time}.`, 409);
  }

  priceLines(offer, option, query, selection) {
    const n = query.participants;
    const base = option.price.amount * n;
    return [
      line('tickets', `${option.name} × ${n}${selection.slot ? ` · ${selection.slot}` : ''}`, 'base', base),
      line('vat', `VAT (${DATA.vat_pct}%)`, 'tax', percentOf(base, DATA.vat_pct)),
    ];
  }

  startDate(offer, query) {
    return query.date;
  }

  lookups() {
    return { where: [...new Set(DATA.items.filter(i => i.kind === this.kind).map(i => i.city))] };
  }
}

class MockActivityProvider extends MockExperienceProvider {
  constructor(opts = {}) {
    super({ ...opts, vertical: 'activities' });
  }
}

module.exports = MockExperienceProvider;
module.exports.MockActivityProvider = MockActivityProvider;
