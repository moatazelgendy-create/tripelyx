// Tripelyx Business service: the facade every Business route calls (plan §L Stage 0 step 11). It holds the
// dependencies and gets its methods from the modules below, each of which exports `methods` (plain
// functions that use `this`). Frozen at the end of Stage 0: the method names in SERVICE_METHODS, their
// `(actor, …)` signatures and the JSDoc in each module.
//
//   team.js      createCompany, listCompaniesFor, getOrg, membership, listMembers, invite, inviteByToken,
//                acceptInvite, revokeInvite, updateMember, removeMember, saveDepartment, listDepartments,
//                saveSettings, exportCompany, listAudit, platformListOrgs, platformSetStatus        (Stage 1W-a),
//                platformCreateHouseCompany                                                      (go-live L0)
//   policies.js  getPolicy, savePolicy, policyHistory                                               (Stage 1W-b)
//   budgets.js   listBudgets, setBudget                                                             (Stage 1W-b)
//   requests.js  searchTrip, createRequest, getRequest, listRequests, swap, submit, cancel, decide,
//                message, inbox, inboxCount, liveCheck                                              (Stage 1W-b)
//   reports.js   dashboard                                                                          (Stage 1W-b)
//   csv.js       exportCsv                                                                          (Stage 1W-b)
//
// `actor` is req.biz.actor from http.memberGate ({ org: { id }, member, user }; a MemberActor) for company
// methods, and { user } (a UserActor) for createCompany, listCompaniesFor, membership, inviteByToken,
// acceptInvite and the platform methods. Every method re-checks the actor itself (actor.loadActor, need),
// so a route bug cannot bypass a permission.
//
// Dependencies (types.BusinessDeps). The service modules reach the policy engine, the trip composer, the
// alternatives and the explainer ONLY through this.policy, this.composer, this.alternatives and
// this.explainer, so Stage 1 tests run them against test/business-fakes.js and app.js injects the real ones.
const team = require('./team');
const policies = require('./policies');
const budgets = require('./budgets');
const requests = require('./requests');
const reports = require('./reports');
const csv = require('./csv');

/** Every service method, frozen (plan §L step 11). */
const SERVICE_METHODS = Object.freeze([
  'createCompany', 'listCompaniesFor', 'getOrg', 'membership', 'listMembers', 'invite', 'inviteByToken', 'acceptInvite',
  'revokeInvite', 'updateMember', 'removeMember', 'saveDepartment', 'listDepartments', 'saveSettings', 'exportCompany',
  'listAudit', 'platformListOrgs', 'platformSetStatus', 'platformCreateHouseCompany', 'getPolicy', 'savePolicy', 'policyHistory', 'listBudgets',
  'setBudget', 'searchTrip', 'createRequest', 'getRequest', 'listRequests', 'swap', 'submit', 'cancel', 'decide',
  'message', 'inbox', 'inboxCount', 'liveCheck', 'dashboard', 'exportCsv',
]);

/** The modules whose `methods` the service carries, by file. */
const MODULES = Object.freeze({ team, policies, budgets, requests, reports, csv });

/** The dependencies a service needs, and the ones it may run without (a test that never searches). */
const REQUIRED_DEPS = Object.freeze(['repo', 'config', 'now']);
const OPTIONAL_DEPS = Object.freeze(['accounts', 'log', 'inventory', 'composer', 'policy', 'alternatives', 'explainer']);

class BusinessService {
  /**
   * @param {import('./types').BusinessDeps} deps repo (a business/repo.js Repo), accounts, config, now
   *   (the injected clock), log, inventory (types.BusinessInventory), composer (types.TripComposer), policy
   *   (types.PolicyEngine), alternatives (types.AlternativesEngine), explainer (types.GuardedExplainer).
   *   repo, config and now are required; the rest may be omitted where a test never reaches them
   *   (a method that needs a missing one fails with a TypeError, never a wrong answer).
   * @throws {TypeError} a required dependency is missing, or an unknown key is passed
   */
  constructor(deps = {}) {
    for (const k of REQUIRED_DEPS) if (!deps[k]) throw new TypeError(`[business] BusinessService needs ${k}`);
    for (const k of Object.keys(deps)) {
      if (!REQUIRED_DEPS.includes(k) && !OPTIONAL_DEPS.includes(k)) throw new TypeError(`[business] unknown BusinessService dependency: ${k}`);
    }
    if (typeof deps.now !== 'function') throw new TypeError('[business] BusinessService now must be a function');
    /** @type {import('./repo').Repo} */
    this.repo = deps.repo;
    this.accounts = deps.accounts || null;
    this.config = deps.config;
    /** @type {() => Date} */
    this.now = deps.now;
    this.log = deps.log || console;
    /** @type {import('./types').BusinessInventory|null} */
    this.inventory = deps.inventory || null;
    /** @type {import('./types').TripComposer|null} */
    this.composer = deps.composer || null;
    /** @type {import('./types').PolicyEngine|null} */
    this.policy = deps.policy || null;
    /** @type {import('./types').AlternativesEngine|null} */
    this.alternatives = deps.alternatives || null;
    /** @type {import('./types').GuardedExplainer|null} */
    this.explainer = deps.explainer || null;
  }
}

// Assign every module's methods, and prove at load time that the union is exactly SERVICE_METHODS with no
// name defined twice (a Stage 1 merge that adds, drops or duplicates a method fails here, not in a route).
const seen = new Map();
for (const [file, mod] of Object.entries(MODULES)) {
  for (const name of Object.keys(mod.methods)) {
    if (seen.has(name)) throw new Error(`[business] ${name} is defined in both ${seen.get(name)}.js and ${file}.js`);
    if (!SERVICE_METHODS.includes(name)) throw new Error(`[business] ${file}.js defines ${name}, which is not a service method`);
    if (typeof mod.methods[name] !== 'function') throw new Error(`[business] ${file}.js ${name} is not a function`);
    seen.set(name, file);
  }
  Object.assign(BusinessService.prototype, mod.methods);
}
for (const name of SERVICE_METHODS) {
  if (!seen.has(name)) throw new Error(`[business] no module defines ${name}`);
}

/** The module file that defines each method (for the interface note and tests). */
const METHOD_MODULE = Object.freeze(Object.fromEntries(seen));

module.exports = { BusinessService, SERVICE_METHODS, METHOD_MODULE, REQUIRED_DEPS, OPTIONAL_DEPS };
