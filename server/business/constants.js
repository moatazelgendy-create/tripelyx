// Tripelyx Business: fixed names and limits shared by every Business module (plan §C, §D). Frozen
// interface: other modules import these names, so renaming one is a breaking change.

/** The owner's confirmed business address (CONTACT_EMAIL is not set on AWS). */
const BUSINESS_EMAIL = 'go@tripelyx.com';

/**
 * Tripelyx's own company (go-live design §3.8): the confirmed legal entity name, never typed. Only a platform
 * admin's "Create Tripelyx Inc" on /admin/business makes it (team.platformCreateHouseCompany); public sign-up
 * and every rename still refuse any company name that says Tripelyx.
 */
const HOUSE_COMPANY_NAME = 'Tripelyx Inc';
/** The one biz_house record's id: inserted once, with the house company, so there is only ever one. */
const HOUSE_ID = 'v1';
/** Why the house company's name can't be changed in its settings (the settings page and saveSettings). */
const HOUSE_NAME_FIXED = "This company's name is fixed.";

/**
 * The sign-up consent box and its error, by the Business inventory's status (go-live design §3.4). The sign-up
 * page (views/business/auth.js), the route's own check (routes/business/public.js) and createCompany all read
 * this one pair, so the box and its error always agree. 'none' (www today: no supplier, no demo) and 'live'
 * name what isn't open; demo and supplier test data keep the preview's own wording.
 */
const SIGNUP_ACK = Object.freeze({
  demo: Object.freeze({
    box: "I understand this is a preview with demo data, and I won't enter real employee travel plans yet.",
    error: "Tick this box to confirm you won't enter real employee travel plans yet.",
  }),
  sandbox: Object.freeze({
    box: "I understand this is a preview, and I won't enter real employee travel plans yet.",
    error: "Tick this box to confirm you won't enter real employee travel plans yet.",
  }),
  live: Object.freeze({
    box: "I understand booking isn't open in Tripelyx Business yet.",
    error: "Tick this box to confirm you've read this.",
  }),
  none: Object.freeze({
    box: "I understand trip search and booking aren't open in Tripelyx Business yet.",
    error: "Tick this box to confirm you've read this.",
  }),
});
/** The consent pair for an inventory status ('none' for anything else, including no inventory). */
const signupAck = status => (typeof status === 'string' && Object.hasOwn(SIGNUP_ACK, status) ? SIGNUP_ACK[status] : SIGNUP_ACK.none);

/** Company statuses: pending until a platform admin confirms it; suspended shuts the workspace. */
const ORG_STATUSES = Object.freeze(['pending', 'active', 'suspended']);

/** Member statuses: a removed member keeps a record (members are never deleted). */
const MEMBER_STATUSES = Object.freeze(['active', 'removed']);

/** The most records any list or scan holds at once (D6: anything that can grow pages instead). */
const LIST_LIMIT = 1000;
/** Rows per page on lists and the audit log. */
const PAGE_SIZE = 50;
/** Members per company (memberCount under CAS on biz_org). */
const MEMBER_CAP = 1000;
/** Aggregates page through at most this many requests and then say so. */
const SCAN_CAP = 5000;
/** Departments per company (listed with Repo.list, which is bounded at 200). */
const DEPARTMENT_CAP = 200;

/** Company sizes on the sign-up form (the same list as the /business enquiry form's "Company size"). */
const COMPANY_SIZES = Object.freeze(['1-10 people', '11-50 people', '51-200 people', '201-1,000 people', 'More than 1,000 people']);
/** The department every new company starts with (its Owner is placed in it). */
const GENERAL_DEPARTMENT = 'General';

/**
 * Record kinds in the generic store. server/business/repo.js is the only module that reads or writes them.
 * Plan §C3 has each kind's id, owner slot, write mode and shape.
 */
const KINDS = Object.freeze({
  org: 'biz_org',
  member: 'biz_member',
  userIndex: 'biz_user_index',
  invite: 'biz_invite',
  inviteEmail: 'biz_invite_email',
  department: 'biz_department',
  policy: 'biz_policy',
  policyVersion: 'biz_policy_version',
  budget: 'biz_budget',
  request: 'biz_request',
  reqLink: 'biz_req_link',
  audit: 'biz_audit',
  // Which company is Tripelyx's own (HOUSE_ID only, insert-only; owner and orgId the house company).
  house: 'biz_house',
});

/** Id prefixes for `lib/ids.id(prefix)`: org_, dep_, btr_, aud_, inv_ (invite publicId). */
const ID_PREFIX = Object.freeze({ org: 'org', department: 'dep', request: 'btr', audit: 'aud', invite: 'inv' });

/** Policy tiers; every member has one (default standard). */
const TIERS = Object.freeze(['standard', 'director', 'executive']);
/** Tier → label. */
const TIER_LABELS = Object.freeze({ standard: 'Standard', director: 'Director', executive: 'Executive' });

/** Stored request statuses (§C5). "past" is a display-only effective status, never stored. */
const REQUEST_STATUSES = Object.freeze(['draft', 'pending', 'approved', 'denied', 'cancelled', 'expired']);

/** Why a trip needs an exception (the Request Approval form). */
const REASON_CATEGORIES = Object.freeze(['client_meeting', 'schedule', 'no_option', 'other']);
/** Reason category → label. */
const REASON_CATEGORY_LABELS = Object.freeze({
  client_meeting: 'Client meeting',
  schedule: 'Schedule',
  no_option: 'No option inside policy',
  other: 'Other',
});

/** Cabins, lowest first. */
const CABINS = Object.freeze(['economy', 'premium', 'business']);
/** Cabin → rank, for "at or below the policy's cabin" (economy < premium < business). */
const CABIN_RANK = Object.freeze({ economy: 0, premium: 1, business: 2 });
/** Cabin → label. */
const CABIN_LABELS = Object.freeze({ economy: 'Economy', premium: 'Premium economy', business: 'Business' });

/**
 * biz_req_link roles: the traveler's own link, the assigned approver's, one per pool member, and the
 * decider's (written by every approve or deny, whatever decidedAs, so "Decided by you" also finds the
 * decisions an approval.override holder made on requests assigned to someone else).
 */
const REQ_LINK_ROLES = Object.freeze(['traveler', 'approver', 'pool', 'decider']);

/** Company settings (§B6, §C3). */
const OUT_OF_POLICY_MODES = Object.freeze(['approval', 'block']);
const BUDGET_PERIODS = Object.freeze(['quarter', 'month']);
/** Approval expiry per company, in hours: [min, max]. */
const APPROVAL_HOURS_RANGE = Object.freeze([4, 168]);
/** Shortest exception reason a company may require (and the default). */
const REASON_MIN_CHARS = 10;
/** A new company's time zone, and the ones the sign-up form offers. */
const DEFAULT_TIMEZONE = 'Africa/Cairo';
const TIMEZONES = Object.freeze([
  'Africa/Cairo', 'Asia/Dubai', 'Asia/Riyadh', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome',
  'Europe/Athens', 'Europe/Istanbul', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC',
]);
/** Every amount is US dollars in phase 1. */
const CURRENCY = 'USD';

/**
 * Audit groups and the actions in each (§C7). An action's group is the part before the dot. Beyond the §C7
 * table: 'request.repriced', for a submit whose price check found a changed or unavailable price and wrote
 * the re-priced draft instead of submitting (every change carries its audit entry, D7).
 */
const AUDIT_ACTIONS = Object.freeze({
  org: Object.freeze(['org.created', 'org.house_created', 'org.confirmed', 'org.suspended', 'org.reactivated', 'org.settings_changed', 'org.exported']),
  member: Object.freeze(['member.invited', 'member.invite_revoked', 'member.joined', 'member.updated', 'member.role_changed', 'member.removed']),
  department: Object.freeze(['department.created', 'department.renamed', 'department.archived']),
  policy: Object.freeze(['policy.published']),
  budget: Object.freeze(['budget.set']),
  request: Object.freeze([
    'request.drafted', 'request.swapped', 'request.repriced', 'request.auto_approved', 'request.submitted', 'request.approved', 'request.denied',
    'request.returned', 'request.cancelled', 'request.expired', 'request.message',
  ]),
  reports: Object.freeze(['reports.exported']),
});
/** Audit groups, in the activity filter's order. */
const AUDIT_GROUPS = Object.freeze(Object.keys(AUDIT_ACTIONS));

module.exports = {
  BUSINESS_EMAIL, HOUSE_COMPANY_NAME, HOUSE_ID, HOUSE_NAME_FIXED, SIGNUP_ACK, signupAck, ORG_STATUSES, MEMBER_STATUSES, LIST_LIMIT, PAGE_SIZE, MEMBER_CAP, SCAN_CAP, DEPARTMENT_CAP, COMPANY_SIZES,
  GENERAL_DEPARTMENT, KINDS, ID_PREFIX,
  TIERS, TIER_LABELS, REQUEST_STATUSES, REASON_CATEGORIES, REASON_CATEGORY_LABELS, CABINS, CABIN_RANK, CABIN_LABELS,
  REQ_LINK_ROLES, OUT_OF_POLICY_MODES, BUDGET_PERIODS, APPROVAL_HOURS_RANGE, REASON_MIN_CHARS, DEFAULT_TIMEZONE,
  TIMEZONES, CURRENCY, AUDIT_ACTIONS, AUDIT_GROUPS,
};
