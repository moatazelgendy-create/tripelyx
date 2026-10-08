// Travel policies per tier: read, edit (a new version per save) and history (plan §E1, §B4 policy pages).
// BusinessService methods (service.js assigns `methods` onto its prototype); `this` is the service.
// STUB from Stage 0 with the frozen interface; Stage 1W-b builds it.
//
// - Validation and the change list come from the policy engine through this.policy (normalizePolicy,
//   formFromPolicy, policyChanges, describe), never by requiring policy/* directly, so tests can inject
//   test/business-fakes.fakePolicy().
// - The editor's choices (airports, carriers, countries) come from this.inventory (airports(), carriers())
//   plus the country names of policy/defaults.js.
// - A save is one repo.commit: biz_policy CAS on the form's rev (version + 1, rules, updatedAt, updatedBy),
//   the biz_policy_version insert (id `${orgId}.${tier}.v${version}`, note, changes), and audit
//   'policy.published' (tier, from, to, changes). Nothing is written when the rules did not change.
// - Requests keep the evaluation they were made with: a save never re-evaluates stored requests.

function notBuilt() { throw new Error('[business] not built'); }

/** Versions per history page. */
const HISTORY_PAGE = 10;

const methods = {
  /**
   * A tier's current policy. tier null = the member's own tier (GET /o/:orgId/policy, org.view); a named
   * tier needs policy.view.all unless it is the member's own. form and refs are filled for policy.edit holders.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').Tier|null} tier
   * @returns {Promise<import('./types').PolicyView>}
   * @throws {AppError} 404 for an unknown tier; 403 'forbidden'
   */
  async getPolicy(actor, tier) { notBuilt(); },

  /**
   * Publish a new version of a tier's policy (policy.edit). this.policy.normalizePolicy(form, refs) →
   * rules; this.policy.policyChanges(before, after) → changes.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').Tier} tier
   * @param {{ form: import('./types').PolicyForm, rev: string|number, note?: string }} input note ≤ 300
   *   characters ("What changed?"), cleaned with validate.text
   * @returns {Promise<{ policy: import('./types').Policy, version: import('./types').PolicyVersion|null }>}
   *   version null when nothing changed (no write)
   * @throws {AppError} 404 unknown tier; 403; 422 'invalid_policy' with details keyed by form field name;
   *   409 'conflict' (stale rev: "Someone changed this while you were looking. Here is the latest version.")
   */
  async savePolicy(actor, tier, input) { notBuilt(); },

  /**
   * A tier's versions, newest first, HISTORY_PAGE per page (policy.view.all). Reads biz_policy_version by id
   * (`${orgId}.${tier}.v${n}`) from `before − 1` down, so no scan.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').Tier} tier
   * @param {{ before?: number|string|null }} [opts] a version number; omitted = from the current version
   * @returns {Promise<import('./types').PolicyHistoryView>}
   * @throws {AppError} 404 unknown tier or a bad `before`; 403
   */
  async policyHistory(actor, tier, opts) { notBuilt(); },
};

module.exports = { methods, HISTORY_PAGE };
