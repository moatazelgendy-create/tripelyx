// Factory for the demo providers, keyed by vertical. Only the provider registry imports this.
const MockHotelProvider = require('./MockHotelProvider');
const MockFlightProvider = require('./MockFlightProvider');
const MockCarProvider = require('./MockCarProvider');
const MockCruiseProvider = require('./MockCruiseProvider');
const MockYachtProvider = require('./MockYachtProvider');
const MockTransferProvider = require('./MockTransferProvider');
const MockExperienceProvider = require('./MockExperienceProvider');
const { MockActivityProvider } = MockExperienceProvider;

const FACTORIES = {
  hotels: opts => new MockHotelProvider(opts),
  flights: opts => new MockFlightProvider(opts),
  cars: opts => new MockCarProvider(opts),
  cruises: opts => new MockCruiseProvider(opts),
  yachts: opts => new MockYachtProvider(opts),
  transfers: opts => new MockTransferProvider(opts),
  activities: opts => new MockActivityProvider(opts),
  experiences: opts => new MockExperienceProvider({ ...opts, vertical: 'experiences' }),
};

module.exports = {
  FACTORIES,
  MockHotelProvider, MockFlightProvider, MockCarProvider, MockCruiseProvider,
  MockYachtProvider, MockTransferProvider, MockActivityProvider, MockExperienceProvider,
};
