// Tripelyx Business: fixed names and limits shared by every Business module. Frozen interface: other
// modules import these names, so renaming one is a breaking change.

/**
 * The nine pipeline stages, in pipeline order (the spec's "LEAD PIPELINE").
 * @type {ReadonlyArray<'new_lead'|'needs_review'|'proposal_sent'|'client_reviewing'|'revision_requested'|'approved'|'payment_pending'|'booked'|'lost'>}
 */
const STAGES = Object.freeze([
  'new_lead', 'needs_review', 'proposal_sent', 'client_reviewing', 'revision_requested',
  'approved', 'payment_pending', 'booked', 'lost',
]);

/** Stage key → label, exactly as the spec names them. @type {Readonly<Record<string, string>>} */
const STAGE_LABELS = Object.freeze({
  new_lead: 'New Lead',
  needs_review: 'Needs Review',
  proposal_sent: 'Proposal Sent',
  client_reviewing: 'Client Reviewing',
  revision_requested: 'Revision Requested',
  approved: 'Approved',
  payment_pending: 'Payment Pending',
  booked: 'Booked',
  lost: 'Lost',
});

/** Stages only a person sets ("set by your team"); automatic moves never leave them. */
const AUTO_LOCKED = Object.freeze(['payment_pending', 'booked', 'lost']);

/** The owner's confirmed business address (CONTACT_EMAIL is not set on AWS). */
const BUSINESS_EMAIL = 'go@tripelyx.com';

/** Options per proposal version (slots A, B, C). */
const MAX_OPTIONS = 3;
/** Option slot keys, in order. */
const OPTION_KEYS = Object.freeze(['A', 'B', 'C']);
/** Share links per proposal (client and traveler links together). */
const MAX_SHARES = 6;
/** Lists stop here; pages then say "Showing the 1,000 most recent." */
const LIST_LIMIT = 1000;

/**
 * Record kinds in the generic store. server/business/repo.js is the only module that reads or writes them.
 * See plan §D for each kind's id, owner slot, document shape and write mode.
 */
const KINDS = Object.freeze({
  org: 'biz_org',
  brand: 'biz_brand',
  logo: 'biz_logo',
  rules: 'biz_rules',
  member: 'biz_member',
  userOrg: 'biz_user_org',
  invite: 'biz_invite',
  client: 'biz_client',
  proposal: 'biz_proposal',
  draft: 'biz_draft',
  version: 'biz_version',
  versionInternal: 'biz_version_internal',
  share: 'biz_share',
  view: 'biz_view',
  response: 'biz_response',
  message: 'biz_message',
  note: 'biz_note',
  reminder: 'biz_reminder',
  audit: 'biz_audit',
});

/** Id prefixes for `lib/ids.id(prefix)`: org_, cli_, prp_, inv_, shr_, rsp_, bms_, bnt_, rem_, aud_. */
const ID_PREFIX = Object.freeze({
  org: 'org', client: 'cli', proposal: 'prp', invite: 'inv', share: 'shr',
  response: 'rsp', message: 'bms', note: 'bnt', reminder: 'rem', audit: 'aud',
});

/** Audit groups (plan §E). Brand events go in the team group. */
const AUDIT_GROUPS = Object.freeze(['trip', 'pricing', 'team', 'sensitive', 'client']);

/** Client reactions on a share link. */
const RESPONSE_KINDS = Object.freeze(['love', 'cheaper', 'better', 'another', 'ask', 'comment']);

/** "Show Me Another" reasons (value → label). */
const WRONG_REASONS = Object.freeze({
  destinations: 'Different destinations',
  expensive: 'Too expensive',
  short: 'Too short',
  travel: 'Too much travel time',
  hotels: 'Different hotels',
  exciting: 'Something more exciting',
});

/** Reminder kinds (the spec's four plus a custom one). */
const REMINDER_KINDS = Object.freeze(['viewed', 'no_response', 'payment_pending', 'departure', 'custom']);

/** Share link kinds: only a client link can approve. */
const SHARE_KINDS = Object.freeze(['client', 'traveler']);

/** Org statuses: pending until the platform approves it; suspended shuts the workspace and its links. */
const ORG_STATUSES = Object.freeze(['pending', 'active', 'suspended']);

/** Default brand colors (white text on both passes 4.5:1). */
const DEFAULT_COLORS = Object.freeze({ primary: '#0b2545', accent: '#2f6fed' });

module.exports = {
  STAGES, STAGE_LABELS, AUTO_LOCKED, BUSINESS_EMAIL, MAX_OPTIONS, OPTION_KEYS, MAX_SHARES, LIST_LIMIT,
  KINDS, ID_PREFIX, AUDIT_GROUPS, RESPONSE_KINDS, WRONG_REASONS, REMINDER_KINDS, SHARE_KINDS, ORG_STATUSES,
  DEFAULT_COLORS,
};
