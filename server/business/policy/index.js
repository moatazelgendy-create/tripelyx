// The policy engine the BusinessService holds as `this.policy` (types.PolicyEngine): every pure rule Stage 1P
// builds (policy/schema, evaluate, benchmark, describe, plus approver.js and lifecycle.js) in one object, so
// a test can hand the service test/business-fakes.fakePolicy() instead. Wiring only (Stage 0); the modules
// behind it own the behaviour.
const schema = require('./schema');
const evaluate = require('./evaluate');
const bench = require('./benchmark');
const describe = require('./describe');
const approver = require('../approver');
const lifecycle = require('../lifecycle');

/** The PolicyEngine methods, in a fixed order (fakes and tests check against it). */
const POLICY_ENGINE_METHODS = Object.freeze([
  'normalizePolicy', 'formFromPolicy', 'policyChanges',
  'benchmark', 'flightValues', 'hotelValues',
  'flightCap', 'hotelCap', 'evaluateComponent', 'evaluateTrip', 'priceToBeat',
  'describe', 'limitsBar',
  'resolveApprover', 'transition', 'effectiveStatus', 'expiresAt',
]);

/**
 * The real policy engine. Each call reads the module's current export, so it always runs the built code.
 * @returns {import('../types').PolicyEngine}
 */
function createPolicyEngine() {
  const from = {
    normalizePolicy: schema, formFromPolicy: schema, policyChanges: schema,
    benchmark: bench, flightValues: bench, hotelValues: bench,
    flightCap: evaluate, hotelCap: evaluate, evaluateComponent: evaluate, evaluateTrip: evaluate, priceToBeat: evaluate,
    describe, limitsBar: describe,
    resolveApprover: approver, transition: lifecycle, effectiveStatus: lifecycle, expiresAt: lifecycle,
  };
  return Object.freeze(Object.fromEntries(POLICY_ENGINE_METHODS.map(name => [name, (...args) => from[name][name](...args)])));
}

module.exports = { createPolicyEngine, POLICY_ENGINE_METHODS };
