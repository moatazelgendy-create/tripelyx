// Travel policies per tier: read, edit (a new version per save) and history (plan §E1, §B4 policy pages).
// BusinessService methods (service.js assigns `methods` onto its prototype); `this` is the service.
//
// - Validation and the change list come from the policy engine through this.policy (normalizePolicy,
//   formFromPolicy, policyChanges, describe), never by requiring policy/schema, evaluate, benchmark or
//   describe directly, so tests can inject test/business-fakes.fakePolicy().
// - The editor's choices (airports, carriers, countries) come from this.inventory (airports(), carriers())
//   plus the country names of policy/defaults.js (plain, final data: require it directly).
// - A save is one repo.commit: biz_policy CAS on the form's rev (version + 1, rules, updatedAt, updatedBy),
//   the biz_policy_version insert (id `${orgId}.${tier}.v${version}`, note, changes), and audit
//   'policy.published' (tier, from, to, changes). Nothing is written when the rules did not change.
// - Requests keep the evaluation they were made with: a save never re-evaluates stored requests.
// - Stale forms: a save whose rev is not the stored one answers 409 'conflict' before anything is checked, and
//   a race lost at commit (the pointer's rev, or the version id taken by the winner) answers the same.
const { AppError } = require('../lib/errors');
const { KINDS, TIERS, TIER_LABELS } = require('./constants');
const { can } = require('./roles');
const { loadActor, need, who, auditInsert, notFound } = require('./actor');
const { text } = require('./validate');
const { DEFAULT_POLICIES } = require('./policy/defaults');

/** Versions per history page. */
const HISTORY_PAGE = 10;
/** The longest "What changed?" note. */
const NOTE_MAX = 300;
/** An audit entry holds at most this many changes (the version record keeps them all). */
const AUDIT_CHANGES_MAX = 100;

/** The 409 for a stale policy form (plan §B6 "Stale rev"). */
const stale = () => new AppError('conflict', 'Someone changed this while you were looking. Here is the latest version.', 409);
/** A form's rev (an integer or a digit string) as a number, or NaN. */
const formRev = rev => (typeof rev === 'number' ? (Number.isInteger(rev) && rev >= 0 ? rev : NaN) : /^\d{1,9}$/.test(String(rev ?? '')) ? Number(rev) : NaN);

/** The tier's current policy record (404 for an unknown tier or a company missing one). */
async function readPolicy(repo, orgId, tier) {
  if (typeof tier !== 'string' || !TIERS.includes(tier)) throw notFound();
  const p = await repo.getIn(KINDS.policy, `${orgId}.${tier}`, orgId);
  if (!p) throw notFound();
  return p;
}

/** Unique, in first-seen order. */
const unique = list => [...new Set(list.filter(x => typeof x === 'string' && x))];

/**
 * The editor's choices and the codes normalizePolicy checks against: the inventory's airports and carriers,
 * the countries of the starting rules and the inventory, and every code the stored rules use (blocked
 * airlines, route exception airports, country caps), so a saved policy always saves again, and the editor can
 * show it, whatever the inventory knows today. A stored code the inventory does not list is shown by its code.
 */
function editorRefs(inventory, rules) {
  const flights = (rules && rules.flights) || {};
  const listed = { airports: inventory ? inventory.airports() : [], carriers: inventory ? inventory.carriers() : [] };
  const storedAirports = unique((flights.routeOverrides || []).flatMap(o => (o ? [o.from, o.to] : [])))
    .filter(code => !listed.airports.some(x => x.code === code));
  const storedCarriers = unique(flights.blockedCarriers || []).filter(code => !listed.carriers.some(c => c.code === code));
  const airports = [...listed.airports, ...storedAirports.map(code => ({ code, city: code, country: '' }))];
  const carriers = [...listed.carriers, ...storedCarriers.map(code => ({ code, name: code }))];
  const countries = unique([
    ...DEFAULT_POLICIES.standard.hotels.countryCaps.map(c => c.country),
    ...listed.airports.map(x => x.country),
    ...((rules && rules.hotels && rules.hotels.countryCaps) || []).map(c => c.country),
  ]).sort((x, y) => x.localeCompare(y, 'en'));
  return {
    view: {
      airports: airports.map(x => ({ code: x.code, city: x.city, country: x.country })),
      carriers: carriers.map(c => ({ code: c.code, name: c.name })),
      countries,
    },
    codes: { airports: airports.map(x => x.code), carriers: carriers.map(c => c.code), countries },
  };
}

/** carriers() as code → name, for texts that name an airline. */
const carrierNames = inventory => Object.fromEntries((inventory ? inventory.carriers() : []).map(c => [c.code, c.name]));

const methods = {
  /**
   * A tier's current policy. tier null = the member's own tier (GET /o/:orgId/policy, org.view); a named
   * tier needs policy.view.all unless it is the member's own. form and refs are filled for policy.edit holders.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').Tier|null} tier
   * @returns {Promise<import('./types').PolicyView>}
   * @throws {AppError} 404 for an unknown tier; 403 'forbidden'
   */
  async getPolicy(actor, tier) {
    const a = await loadActor(this.repo, actor);
    need(a, 'org.view');
    const t = tier === null || tier === undefined || tier === '' ? a.member.tier : tier;
    if (typeof t !== 'string' || !TIERS.includes(t)) throw notFound();
    if (t !== a.member.tier) need(a, 'policy.view.all');
    const p = await readPolicy(this.repo, a.org.id, t);
    const canEdit = can(a.member.role, 'policy.edit');
    const refs = editorRefs(this.inventory, p.rules);
    return {
      tier: t,
      tierLabel: TIER_LABELS[t],
      version: p.version,
      rules: p.rules,
      description: this.policy.describe(p.rules, {
        tier: t, version: p.version, orgName: a.org.name, carriers: carrierNames(this.inventory), demo: !!this.inventory && this.inventory.status === 'demo',
      }),
      updatedAt: p.updatedAt,
      updatedBy: p.updatedBy,
      rev: p.rev ?? 0,
      canEdit,
      defaults: p.version === 1,
      form: canEdit ? this.policy.formFromPolicy(p.rules) : null,
      refs: refs.view,
    };
  },

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
  async savePolicy(actor, tier, input) {
    const a = await loadActor(this.repo, actor);
    need(a, 'policy.edit');
    const orgId = a.org.id;
    const cur = await readPolicy(this.repo, orgId, tier);
    const { form = {}, rev = null, note = '' } = input || {};
    if (formRev(rev) !== (cur.rev ?? 0)) throw stale();
    const rules = this.policy.normalizePolicy(form && typeof form === 'object' ? form : {}, editorRefs(this.inventory, cur.rules).codes);
    const changes = this.policy.policyChanges(cur.rules, rules);
    if (!changes.length) return { policy: cur, version: null };
    const version = cur.version + 1;
    const now = this.repo.iso();
    const by = who(a);
    const cleanNote = text(note, NOTE_MAX, { multiline: true });
    const versionId = `${orgId}.${cur.tier}.v${version}`;
    const label = TIER_LABELS[cur.tier];
    try {
      const docs = await this.repo.commit({
        cas: [{
          kind: KINDS.policy, id: `${orgId}.${cur.tier}`, rev,
          fn: d => {
            if (d.version !== cur.version) throw stale();
            d.version = version; d.rules = rules; d.updatedAt = now; d.updatedBy = by;
          },
        }],
        inserts: [
          { kind: KINDS.policyVersion, id: versionId, owner: orgId, data: { orgId, tier: cur.tier, version, rules, at: now, by, note: cleanNote, changes } },
          auditInsert(this.repo, {
            orgId, actor: by, action: 'policy.published', target: { kind: KINDS.policy, id: `${orgId}.${cur.tier}` },
            summary: `${by.name} published the ${label} policy, version ${version} (was version ${cur.version})`,
            changes: changes.slice(0, AUDIT_CHANGES_MAX),
          }),
        ],
      });
      return { policy: docs[`${KINDS.policy}:${orgId}.${cur.tier}`], version: docs[`${KINDS.policyVersion}:${versionId}`] };
    } catch (e) {
      if (e instanceof AppError && (e.code === 'conflict' || e.code === 'already_exists')) throw stale();
      throw e;
    }
  },

  /**
   * A tier's versions, newest first, HISTORY_PAGE per page (policy.view.all). Reads biz_policy_version by id
   * (`${orgId}.${tier}.v${n}`) from `before − 1` down, so no scan.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').Tier} tier
   * @param {{ before?: number|string|null }} [opts] a version number; omitted = from the current version
   * @returns {Promise<import('./types').PolicyHistoryView>}
   * @throws {AppError} 404 unknown tier or a bad `before`; 403
   */
  async policyHistory(actor, tier, opts = {}) {
    const a = await loadActor(this.repo, actor);
    need(a, 'policy.view.all');
    const orgId = a.org.id;
    const cur = await readPolicy(this.repo, orgId, tier);
    const before = opts && opts.before;
    let top = cur.version;
    if (before !== null && before !== undefined && before !== '') {
      const n = formRev(before);
      if (!Number.isInteger(n) || n < 2 || n > cur.version + 1) throw notFound();
      top = n - 1;
    }
    const numbers = [];
    for (let n = top; n >= 1 && numbers.length < HISTORY_PAGE; n -= 1) numbers.push(n);
    const found = await Promise.all(numbers.map(n => this.repo.getIn(KINDS.policyVersion, `${orgId}.${cur.tier}.v${n}`, orgId)));
    const versions = found.filter(Boolean);
    const lowest = numbers.length ? numbers[numbers.length - 1] : 1;
    return { tier: cur.tier, versions, older: lowest > 1 ? lowest : null };
  },
};

module.exports = { methods, HISTORY_PAGE };
