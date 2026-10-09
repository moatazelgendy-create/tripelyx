// Tripelyx Business: the shared shapes every Business module, route and view codes against (plan §C to §J).
// JSDoc only: this file exports nothing at run time. FROZEN at the end of Stage 0: a Stage 1 or 2 builder may
// add an optional field, but never renames, removes or retypes one. Use the types with
//   /** @typedef {import('./types').Request} Request */
//
// Conventions
// - Money is integer cents (`…Cents`), always US dollars in phase 1 (`currency: 'USD'`). Percentages are
//   integer tenths (`pctTenths: 200` is 20%). Views format money; data never holds formatted amounts,
//   except the plain-English `text` of a Violation or a LimitItem suffix, which lib/money formats.
// - Times are ISO strings from the injected clock (`at`, `updatedAt`, `pricedAt`, …). Dates are
//   'YYYY-MM-DD' strings. Local wall-clock times are 'YYYY-MM-DDTHH:MM' strings with no offset.
// - Every record written by Business is plain JSON (repo.assertDoc): no undefined, Date, NaN or Infinity.
//   An "optional" field below is still present, holding null, unless it is marked `[field]`.
// - Ids: org_, usr_, btr_ (request), dep_ (department), aud_ (audit), inv_ (invite publicId), each followed
//   by 16 base64url characters (lib/ids.id). Composite ids join parts with '.'.
// - Real suppliers, round 1 (step R1-0, real-suppliers design §8.1 and §8.6): InventoryStatus gains 'sandbox';
//   FlightRow.demo, HotelRow.demo and Request.demo become booleans ("not a real price": true for demo and
//   sandbox, false only for live); the rest is additive and optional (PriceSource, CheckLevel, SkipCounts,
//   the provider query and offer details additions, searchDetailed, leg skipped/error, Request.source,
//   EvalCtx.priceSource, RequestView.liveError, the BusinessInventory fields). source.js holds the matching
//   code: sourceOf, leastReal, requestSource, the row id namespaces and the frozen TERMS sentences.
//   Added at the R1-m merge (both builders' needs): GetOfferOpts and QuoteInput (the provider calls),
//   RequestRow.source, ReportTiles.priceSource, DashboardView.priceSource, CompanyExport's price_source and
//   note, and describe's demo/source options.

// =============================================================================================================
// 0. Names

/** @typedef {'owner'|'travel_admin'|'finance'|'manager'|'employee'} Role */
/**
 * One of roles.PERMISSIONS: 'org.view', 'trip.request', 'request.view.own', 'request.view.team',
 * 'request.view.all', 'approval.decide', 'approval.override', 'policy.view.all', 'policy.edit',
 * 'budget.view.dept', 'budget.view.all', 'budget.edit', 'members.view', 'members.manage', 'departments.manage',
 * 'reports.view', 'reports.export', 'audit.view', 'settings.travel', 'settings.company'.
 * @typedef {string} Permission
 */
/** @typedef {'standard'|'director'|'executive'} Tier */
/** @typedef {'economy'|'premium'|'business'} Cabin */
/** @typedef {'pending'|'active'|'suspended'} OrgStatus */
/** @typedef {'active'|'removed'} MemberStatus */
/** @typedef {'draft'|'pending'|'approved'|'denied'|'cancelled'|'expired'} RequestStatus */
/** What a page shows: the stored status, or 'expired' (pending past expiresAt) or 'past' (approved, departed). @typedef {RequestStatus|'past'} EffectiveStatus */
/** @typedef {'client_meeting'|'schedule'|'no_option'|'other'} ReasonCategory */
/** @typedef {'approval'|'block'} OutOfPolicyMode */
/** @typedef {'quarter'|'month'} BudgetPeriod */
/** '2026-Q4' (quarter) or '2026-11' (month), from the departure's local date. @typedef {string} PeriodKey */
/**
 * 'demo' Tripelyx demo inventory; 'sandbox' real suppliers' test systems (round 1: Duffel test mode, LiteAPI
 * sandbox; every amount is supplier test data); 'live' real suppliers' live systems (round 1b); 'none' no supplier.
 * @typedef {'demo'|'sandbox'|'live'|'none'} InventoryStatus
 */
/**
 * Where a price came from (source.js), least real first: 'demo' Tripelyx demo data, 'sandbox' a supplier's test
 * system, 'live' a supplier's live system. A row's source is read from its offer id's namespace
 * (source.sourceOf: flt_t./htl_t. sandbox, flt_l./htl_l. live, anything else demo).
 * @typedef {'demo'|'sandbox'|'live'} PriceSource
 */
/**
 * How far a price check may go with a real supplier (composer.price(..., { check }), carried as pq.check; demo
 * providers and the frozen fakes ignore it). Design §5.1.
 *   'auto'    createRequest, swap, price (the default): the short cache, else as 'confirm'
 *   'peek'    the approver's page (getRequest, liveCheck): the cache, or one GET of a cached Duffel offer with
 *             more than 60 s left. Never a search, never a prebook; otherwise 503 'live_check_skipped'
 *   'confirm' submit: a fresh answer (Duffel GET offer, re-searching the leg when the offer is unknown or
 *             expired; LiteAPI rates for that hotel). No prebook
 *   'final'   decide: as 'confirm', then the LiteAPI prebook
 * @typedef {'auto'|'peek'|'confirm'|'final'} CheckLevel
 */
/**
 * The live-check errors getRequest turns into RequestView.liveError (source.LIVE_ERROR_CODES); it rethrows any other.
 * @typedef {'supplier_unavailable'|'supplier_busy'|'live_check_skipped'|'unsupported_currency'} LiveCheckError
 */
/** @typedef {'within'|'out'|'blocked'} PolicyStatus */
/** @typedef {'out'|'back'|'hotel'} Component */
/** @typedef {'fare'|'flight'|'stops'|'cabin'|'dates'|'room'|'hotel'|'all_within'} ChangeKind */
/** @typedef {'bizAuthIp'|'bizAuthAccount'|'bizWrite'|'bizCompute'} LimiterName */

// =============================================================================================================
// 1. Accounts and actors

/**
 * The signed-in user as routes see it (req.user from accounts.userFromRequest): the user record without
 * passwordHash, plus isAdmin (a platform admin, D1). Business never reads `profile` or personal records.
 * @typedef {object} User
 * @property {string} id usr_…
 * @property {string} name
 * @property {string} email lowercased
 * @property {string} createdAt
 * @property {boolean} isAdmin platform admin (may open /admin/business; gets nothing inside a company from it)
 * @property {{ via: 'invite', orgId: string, at: string }} [emailProof] D5: set when the account was created from an invite
 */

/**
 * Who calls a service method that needs no company: createCompany, listCompaniesFor, membership,
 * inviteByToken (user may be null there), acceptInvite, platformListOrgs, platformSetStatus.
 * @typedef {{ user: User|null }} UserActor
 */

/**
 * Who calls a company method: req.biz.actor from memberGate. The service never trusts `org` or `member`
 * in it: actor.loadActor re-reads both by id on every call (404 forged/stale/removed, 403 suspended).
 * @typedef {object} MemberActor
 * @property {{ id: string }} org at least the id; usually the Org memberGate read
 * @property {Member} [member] ignored by the service (re-read)
 * @property {User} user
 */

/** actor.loadActor's result: the company and member as stored right now. @typedef {{ org: Org, member: Member, user: User }} LoadedActor */

/**
 * Who did something, as audit entries, request history and decisions record it (actor.who,
 * actor.platformActor, actor.systemActor). Names are snapshotted.
 * @typedef {{ userId: string, name: string, role: Role }
 *   | { platformAdmin: string, name: string }
 *   | { system: 'policy'|'clock' }} ActorRef
 */

/**
 * The `platform_admin` record (accounts, D1). Id and owner: the user id.
 * @typedef {object} PlatformAdminRecord
 * @property {string} userId
 * @property {string} email the email when granted; isPlatformAdmin needs it to still match and to be in ADMIN_EMAILS
 * @property {string} grantedAt
 * @property {'legacy-email-match'|'cli'|'test'} grantedBy
 * @property {string|null} revokedAt
 * @property {string} note
 * @property {number} rev
 */

// =============================================================================================================
// 2. Stored records (plan §C3, §C4). constants.KINDS names each kind; repo.js is the only module that reads
//    or writes them.

/**
 * @typedef {object} OrgSettings
 * @property {OutOfPolicyMode} outOfPolicy 'approval' (default): out of policy needs Request Approval; 'block': refused
 * @property {number} approvalHours 4..168, default config.business.approvalHours (24)
 * @property {number} reasonMinChars shortest exception reason (10)
 * @property {BudgetPeriod} budgetPeriod default 'quarter'
 */

/**
 * `biz_org`, id org_… (the only kind with no owner scope). Inserted by createCompany, then changed by CAS.
 * As company members see it (getOrg, saveSettings, acceptInvite, exportCompany), statusBy and statusNote are always
 * null and settingsRev is left out; only the platform admin's own view (platformSetStatus) carries them.
 * A confirmed ('active') company whose name changes beyond case, spacing and punctuation (nameKey) goes back to
 * 'pending' in the same commit as the rename, until Tripelyx confirms it again (not with config.business.selfServe).
 * @typedef {object} Org
 * @property {string} id
 * @property {string} name NFKC text ≤ 80, never containing "tripelyx"
 * @property {string} nameKey lowercased letters and digits of the name (the platform's "similar name" hint)
 * @property {OrgStatus} status
 * @property {string} size one of the sign-up's company sizes ('1-10 people' … 'More than 1,000 people')
 * @property {'USD'} currency
 * @property {string} timezone one of constants.TIMEZONES (default 'Africa/Cairo')
 * @property {OrgSettings} settings
 * @property {string[]} ownerIds active owners; never empty (D8: changes in the same commit as the member)
 * @property {number} memberCount active members, ≤ constants.MEMBER_CAP, under CAS
 * @property {string} createdBy user id
 * @property {string} at
 * @property {string} updatedAt
 * @property {string|null} statusBy platform admin user id of the last status change
 * @property {string|null} statusAt
 * @property {string|null} statusNote required for a suspension
 * @property {number} [settingsRev] the org rev written by the last settings change (saveSettings); absent means 0.
 *   A settings form is stale (409) only when its rev is below this or above rev, so joins, removals and status
 *   changes in between leave an open settings form current.
 * @property {string} [previousName] the name Tripelyx confirmed, written when a rename sends a confirmed company back
 *   to 'pending' (saveSettings). Only platformListOrgs reads it (PlatformOrgRow.previousName); members' views leave it out.
 * @property {number} rev
 */

/**
 * `biz_member`, id `${orgId}.${userId}`, owner orgId. Inserted, then CAS. Never deleted: removal sets
 * status 'removed'. managerId and approverId are user ids of members of the same company, never the member's own.
 * @typedef {object} Member
 * @property {string} orgId
 * @property {string} userId
 * @property {string} email shown only with members.manage
 * @property {string} name
 * @property {Role} role
 * @property {MemberStatus} status
 * @property {string|null} departmentId dep_…
 * @property {string|null} managerId
 * @property {string|null} approverId explicit approver; wins over the manager (approver.resolveApprover)
 * @property {Tier} tier
 * @property {string} at joined
 * @property {string|null} by who added them (user id; null for the creator)
 * @property {string|null} removedAt
 * @property {number} rev
 */

/** `biz_user_index`, id and owner userId: the companies a user belongs to (switcher, D4 cap). @typedef {{ userId: string, orgIds: string[], rev: number }} UserIndex */

/**
 * `biz_invite`, id sha256(token) hex (= tokenHash), owner orgId. The token itself is never stored.
 * @typedef {object} Invite
 * @property {string} orgId
 * @property {string} publicId inv_… (the id pages, forms and audit entries use)
 * @property {string} tokenHash
 * @property {string} email lowercased; the joining account's email must be exactly this
 * @property {Role} role
 * @property {string|null} departmentId
 * @property {string|null} managerId
 * @property {string|null} approverId
 * @property {Tier} tier
 * @property {string} invitedBy user id
 * @property {string} at
 * @property {string} expiresAt at + config.business.inviteDays
 * @property {string|null} acceptedAt
 * @property {string|null} acceptedBy user id
 * @property {string|null} revokedAt
 * @property {'replaced'|'removed'|'manual'|null} revokedReason
 * @property {number} rev
 */

/**
 * `biz_invite_email`, id `${orgId}.${sha256(email).slice(0, 32)}`, owner orgId: the one pending invite per
 * (company, email) (D3). inviteHash null when none is pending.
 * @typedef {{ orgId: string, inviteHash: string|null, rev: number }} InviteEmail
 */

/**
 * `biz_department`, id dep_…, owner orgId. Archived departments keep their budgets and history.
 * @typedef {{ id: string, orgId: string, name: string, archivedAt: string|null, at: string, updatedAt: string, rev: number }} Department
 */

/**
 * `biz_policy`, id `${orgId}.${tier}`, owner orgId: the current version of one tier's rules.
 * @typedef {object} Policy
 * @property {string} orgId
 * @property {Tier} tier
 * @property {number} version 1 at creation (policy/defaults.js), +1 per save
 * @property {PolicyRules} rules
 * @property {string} updatedAt
 * @property {ActorRef} updatedBy
 * @property {number} rev
 */

/**
 * `biz_policy_version`, id `${orgId}.${tier}.v${version}`, owner orgId. Insert-only, in the same commit as
 * the Policy pointer. Version 1 has note DEFAULTS_NOTE and no changes.
 * @typedef {object} PolicyVersion
 * @property {string} orgId
 * @property {Tier} tier
 * @property {number} version
 * @property {PolicyRules} rules
 * @property {string} at
 * @property {ActorRef} by
 * @property {string} note "What changed?" (≤ 300)
 * @property {Change[]} changes from policy/schema.policyChanges(previous, rules)
 */

/** One field change: a dotted path ('hotels.countryCaps[United Kingdom].nightlyCents') and its two values. @typedef {{ path: string, before: any, after: any }} Change */

/**
 * `biz_budget`, id `${orgId}.${departmentId}.${periodKey}`, owner orgId. committed = Σ commits (≤ 2,000
 * keys). A hold is added on approval and removed on cancel, in the same commit as the request.
 * @typedef {object} Budget
 * @property {string} orgId
 * @property {string} departmentId
 * @property {PeriodKey} periodKey
 * @property {number} amountCents
 * @property {'USD'} currency
 * @property {Record<string, number>} commits request id → cents held
 * @property {string} at
 * @property {string} updatedAt
 * @property {ActorRef} updatedBy
 * @property {number} rev
 */

/**
 * `biz_req_link`, id `${requestId}.${role}.${userId}`, owner repo.memberScope(orgId, userId). Insert-only.
 * A hint for "my requests" and the inbox; every read re-validates the request with getIn and roles.allowed.
 * role 'decider' is written by every approve or deny (any decidedAs), for "Decided by you" (constants.REQ_LINK_ROLES).
 * @typedef {{ orgId: string, requestId: string, userId: string, role: 'traveler'|'approver'|'pool'|'decider', at: string }} ReqLink
 */

/**
 * `biz_audit`, id aud_…, owner orgId. Insert-only, always in the same commit as the change (D7); built by
 * actor.auditInsert. group is the action's prefix (constants.AUDIT_ACTIONS).
 * @typedef {object} AuditEntry
 * @property {string} id
 * @property {string} orgId
 * @property {string} at
 * @property {ActorRef} actor
 * @property {string} action e.g. 'request.approved'
 * @property {string} group e.g. 'request'
 * @property {{ kind: string, id: string }} target
 * @property {string} summary plain English, ≤ 300 ("Dana Lee approved Sam Traveler's trip to London")
 * @property {Change[]} changes
 */

/**
 * The request's reason for an exception (Request Approval form).
 * @typedef {{ text: string, category: ReasonCategory|null }} RequestReason
 */

/**
 * How a request was (or will be) decided. Set on submit; decidedBy/decidedAt/decidedAs/note on decision.
 * @typedef {object} RequestApproval
 * @property {'auto'|'manual'} mode auto = within policy and budget ("Approved by policy")
 * @property {string|null} approverId the assigned approver (null for auto, or when only the pool can decide)
 * @property {boolean} pool true when no approver or manager was valid and the admins' pool decides
 * @property {string[]} poolIds the pool's user ids when pool is true (else [])
 * @property {'approver'|'manager'|'admin'|null} rule how the approver was found (null for auto)
 * @property {ActorRef|null} decidedBy {system:'policy'} for auto
 * @property {string|null} decidedAt
 * @property {'assigned'|'pool'|'override'|null} decidedAs null for auto
 * @property {string} note the decider's note ('' when none; required for deny and override)
 * @property {boolean} overBudgetAck the decider approved past the budget
 */

/** A budget hold on an approved request. @typedef {{ budgetId: string, periodKey: PeriodKey, cents: number }} RequestBudget */

/**
 * Set when an automatic re-check sent a pending request back to draft (or a draft's price or terms moved on
 * submit). why: 'price_changed' the total moved (toCents ≠ fromCents); 'terms_changed' the same total but the
 * fare or room terms changed (toCents === fromCents: never say the price changed); 'unavailable' an option is
 * gone (toCents null).
 * @typedef {{ at: string, why: 'price_changed'|'terms_changed'|'unavailable', fromCents: number, toCents: number|null }} RequestReturned
 */

/** @typedef {{ at: string, by: string, name: string, text: string }} RequestMessage by = user id; text 2..1000 */

/**
 * One line of a request's history (≤ 50; the oldest are dropped from the record, never from the audit log).
 * action: 'drafted'|'swapped'|'repriced'|'submitted'|'auto_approved'|'approved'|'denied'|'returned'|'cancelled'|'expired'.
 * @typedef {{ at: string, by: ActorRef, action: string, from: RequestStatus|null, to: RequestStatus,
 *   note: string, savedCents?: number }} HistoryEntry savedCents only on 'swapped' (pick total − new total)
 */

/**
 * The model's own wording about the alternatives, stored with them (explainer output after the guard).
 * @typedef {{ summary: string, explainer: string }} RequestExplanation explainer: the explainer's name ('rules')
 */

/**
 * `biz_request`, id btr_…, owner orgId (plan §C4). The traveler, department, tier and policy version are
 * snapshotted when the draft is created. `rows` are allow-listed DTOs (dto.js); `selection` and `query`
 * are only ever used to price again, never rendered as-is.
 * @typedef {object} Request
 * @property {string} id
 * @property {string} orgId
 * @property {string} travelerId
 * @property {string} travelerName
 * @property {string|null} travelerManagerId
 * @property {string|null} departmentId
 * @property {Tier} tier
 * @property {RequestStatus} status
 * @property {number} rev
 * @property {string} at
 * @property {string} updatedAt
 * @property {string} purpose 3..140
 * @property {TripQuery} query
 * @property {Selection} selection
 * @property {{ out: FlightRow, back: FlightRow|null, hotel: HotelRow|null }} rows
 * @property {string} pricedAt
 * @property {'USD'} currency
 * @property {number} totalCents Σ rows' totalCents
 * @property {number} originalTotalCents the first pick's total (savings by switching = original − total)
 * @property {TripEvaluation} evaluation the latest evaluation, with evaluatedAt
 * @property {Alternative[]} alternatives ≤ 5, in the explainer's order
 * @property {boolean} alternativesTruncated
 * @property {Alternative|null} cheapestWithin the cheapest option inside policy the traveler saw (kept for approvers and reports)
 * @property {RequestExplanation|null} explanation null when within policy (no alternatives were looked for)
 * @property {RequestReason|null} reason
 * @property {RequestApproval|null} approval
 * @property {string|null} submittedAt
 * @property {string|null} expiresAt lifecycle.expiresAt(...) for a pending request
 * @property {RequestBudget|null} budget the hold while approved (kept as it was after a cancel; the budget record releases it)
 * @property {RequestReturned|null} returned
 * @property {RequestMessage[]} messages ≤ 50
 * @property {HistoryEntry[]} history ≤ 50
 * @property {{ status: 'not_open' }} booking booking is not a phase 1 state
 * @property {boolean} demo not a real price: source.requestSource(request) !== 'live' (true for demo and sandbox)
 * @property {PriceSource} [source] where the rows' prices came from, written from the rows (source.leastReal) when
 *   the request is created, swapped or re-priced. Absent on requests stored before real suppliers: they read as
 *   'demo' (source.requestSource)
 */

// =============================================================================================================
// 3. Policy rules (plan §E1). policy/schema.normalizePolicy builds them; policy/defaults.js holds the starting rules.

/**
 * A price limit. median_pct: median + floor(median × pctTenths / 1000); median_plus: median + amountCents;
 * both fall back to fallbackCents when the search has fewer than 3 comparable fares.
 * @typedef {{ mode: 'none' }
 *   | { mode: 'fixed', amountCents: number }
 *   | { mode: 'median_pct', pctTenths: number, fallbackCents: number }
 *   | { mode: 'median_plus', amountCents: number, fallbackCents: number }} Cap
 */

/**
 * Rules for one haul band.
 * @typedef {object} FlightBand
 * @property {Cap} cap
 * @property {Cabin} maxCabin
 * @property {number} minAdvanceDays 0..365
 * @property {0|1|null} maxStops null = any
 * @property {boolean} refundableOnly fare must refund part of the price (refundablePercent > 0)
 */

/**
 * A route exception; the first match wins over the band's cap and cabin.
 * @typedef {{ from: string, to: string, bothWays: boolean, cap: Cap, maxCabin: Cabin|null }} RouteOverride
 */

/**
 * @typedef {object} FlightRules
 * @property {number} longHaulMinutes 60..1200; flyingMinutes ≥ this → long haul
 * @property {FlightBand} shortHaul
 * @property {FlightBand} longHaul
 * @property {RouteOverride[]} routeOverrides ≤ 50, airports from inventory.airports()
 * @property {string[]} blockedCarriers ≤ 20 carrier codes from inventory.carriers() (severity block)
 */

/** @typedef {{ city: string, nightlyCents: number }} CityCap */
/** @typedef {{ country: string, nightlyCents: number, cities: CityCap[] }} CountryCap ≤ 60 countries, ≤ 20 cities each */

/**
 * @typedef {object} HotelRules
 * @property {'incl_taxes'|'excl_taxes'} capBasis
 * @property {number|null} defaultNightlyCents null = no default cap
 * @property {CountryCap[]} countryCaps city > country > default
 * @property {number|null} maxStars 1..5 (a Tripelyx addition, labelled as one)
 * @property {number} minAdvanceDays
 * @property {boolean} refundableOnly cancellation 'free', or 'partial' with freeUntilHours > 0
 */

/**
 * One tier's rules. Every key is always present (normalizePolicy refuses unknown keys).
 * @typedef {{ flights: FlightRules, hotels: HotelRules, trip: { maxTotalCents: number|null } }} PolicyRules
 */

/**
 * The reference lists normalizePolicy checks codes against (from the inventory; empty with no supplier).
 * @typedef {{ airports: string[], carriers: string[], countries: string[] }} PolicyRefs
 */

/**
 * The policy editor's form, flat url-encoded fields (express.urlencoded extended:false; repeated keys give
 * arrays). Money in dollars ("600" or "600.50"), percentages in percent ("20" or "7.5"), N and M from 0.
 *   longHaulMinutes
 *   short.capMode, short.capAmount, short.capPct, short.fallback, short.maxCabin, short.minAdvanceDays,
 *   short.maxStops ('' any | '0' | '1'), short.refundableOnly ('1' when ticked)        (and the same for long.*)
 *   route.N.from, route.N.to, route.N.bothWays, route.N.capMode, route.N.capAmount, route.N.capPct,
 *   route.N.fallback, route.N.maxCabin ('' = the band's)
 *   blockedCarriers (repeated: one value per ticked carrier code)
 *   hotel.capBasis, hotel.default ('' = none), hotel.maxStars ('' = any), hotel.minAdvanceDays, hotel.refundableOnly
 *   country.N.name, country.N.nightly, country.N.city.M.name, country.N.city.M.nightly
 *   trip.maxTotal ('' = none)
 * Rows whose name/from field is blank are ignored. 422 details are keyed by these field names.
 * @typedef {Record<string, string|string[]>} PolicyForm
 */

// =============================================================================================================
// 4. Search, rows and pricing (plan §F)

/**
 * The raw search form (GET /business/o/:orgId/trips/search?…), as query-string fields:
 *   from, to (IATA codes), depart (YYYY-MM-DD), return (YYYY-MM-DD; blank = one way),
 *   hotel ('1' = I need a hotel), nights (1..14; only used one way with a hotel),
 *   cabin ('economy'|'premium'|'business'), flex ('1' = my dates can move by up to 3 days).
 * POST /trips repeats them as hidden fields, plus out, back, hotelKey (Selection keys) and purpose.
 * There is no check-in field, on purpose: the hotel dates are never taken from a form. POST /trips
 * re-parses these fields and runs composer.search again, which moves hotel.checkIn exactly as it did for
 * the results page; createRequest prices the selection with that SearchResult.query (the query as
 * searched) and stores it as request.query, never the raw re-parse (see requests.createRequest).
 * @typedef {Record<string, string>} RawTripQuery
 */

/** @typedef {{ city: string, country: string, checkIn: string, checkOut: string }} HotelQuery checkIn = the outbound arrival's local date (see search.parseTripQuery) */

/**
 * A parsed trip search (search.parseTripQuery). One traveler in phase 1.
 * @typedef {object} TripQuery
 * @property {string} from IATA
 * @property {string} to IATA, ≠ from
 * @property {string} departDate today (org time zone) .. today + 330
 * @property {string|null} returnDate > departDate, ≤ departDate + 30
 * @property {Cabin} cabin
 * @property {1} passengers
 * @property {boolean} datesFlexible
 * @property {HotelQuery|null} hotel
 */

/**
 * What the traveler picked: row keys only. A key is 'f.<offerId>|<optionId>' (flight) or
 * 'h.<offerId>|<optionId>' (hotel) and matches dto.ROW_KEY_RE.
 * @typedef {{ out: string, back: string|null, hotel: string|null }} Selection
 */

/** @typedef {{ label: string, kind: 'base'|'tax'|'fee'|'discount', cents: number }} RowLine */

/**
 * A flight segment as travelers see it. Times are local to each airport.
 * @typedef {object} RowSegment
 * @property {{ code: string, name: string }} carrier
 * @property {string} flightNumber e.g. 'ZM123'
 * @property {{ code: string, city: string }} from
 * @property {{ code: string, city: string }} to
 * @property {string} departLocal 'YYYY-MM-DDTHH:MM' in the origin's time zone
 * @property {string} arriveLocal 'YYYY-MM-DDTHH:MM' in the destination's time zone
 * @property {number} arriveDayOffset whole days between departLocal's date and arriveLocal's date (the "+1")
 * @property {number} durationMinutes
 */

/**
 * One fare of one itinerary on one leg (dto.FLIGHT_ROW_KEYS is the exact allow-list). An unavailable option
 * has available:false and no price: lines [], totalCents null.
 * @typedef {object} FlightRow
 * @property {string} key 'f.' + offerId + '|' + optionId
 * @property {'flight'} kind
 * @property {'out'|'back'} leg
 * @property {string} offerId its namespace says the price source: 'flt_t.ZZ1234-ZZ88_20261112T0835_economy'
 *   (sandbox), 'flt_l.…' (live), 'flt_ZM429_2026-11-12_economy' (demo)
 * @property {string} optionId fare family code: 'LIGHT'|'CLASSIC'|'FLEX' in the demo; a supplier fare's slug
 *   (≤ 40 characters, stable across searches) for supplier rows
 * @property {{ code: string, name: string }} carrier the itinerary's carrier: for a supplier row the airline
 *   selling the fare (offer details.owner), else the first segment's
 * @property {string[]} flightNumbers
 * @property {RowSegment[]} segments
 * @property {number} stops connections, plus stops inside a segment for supplier rows (details.stops)
 * @property {Array<{ code: string, city: string }>} via connection airports (supplier rows: then the in-segment
 *   stop airports, in travel order, from details.via)
 * @property {number} flyingMinutes Σ segment durationMinutes (layovers excluded; decides the haul)
 * @property {number} elapsedMinutes first departure to last arrival, in UTC
 * @property {Cabin} cabin
 * @property {'Economy'|'Premium economy'|'Business'} cabinLabel
 * @property {{ code: string, name: string, cabinKg: number, checkedBags: number, checkedKg: number,
 *   changeable: boolean, refundablePercent: number, terms: string }} fare supplier rows: cabinKg and checkedKg 0
 *   mean "not stated by the airline"; changeable false and refundablePercent 0 also when the airline doesn't say;
 *   terms is source.TERMS.fare(...) (refunds, changes, bags; read it with source.saysNoChanges,
 *   refundsUnconfirmed, changesUnconfirmed)
 * @property {RowLine[]} lines
 * @property {number|null} totalCents Σ lines
 * @property {'USD'} currency
 * @property {boolean} available
 * @property {boolean} demo not a real price: demo === (source.sourceOf(row) !== 'live') (dto.assertRow)
 * @property {string} pricedAt
 */

/**
 * One room of one hotel (dto.HOTEL_ROW_KEYS is the exact allow-list). No rating, reviews, provider or net rates.
 * @typedef {object} HotelRow
 * @property {string} key 'h.' + offerId + '|' + optionId
 * @property {'hotel'} kind
 * @property {string} offerId 'htl_t.<supplier hotel id>' (sandbox), 'htl_l.…' (live), 'htl_CA-NILE' (demo)
 * @property {string} optionId room code (supplier rows: a slug of the rate, board and refundability, ≤ 40)
 * @property {string} name
 * @property {number} stars supplier rows: as the supplier gives it (may be 4.5); 0 = no star rating from the supplier
 * @property {string} area
 * @property {string} city
 * @property {string} country
 * @property {{ name: string, sleeps: number, bed: string }} room
 * @property {string} checkIn
 * @property {string} checkOut
 * @property {number} nights
 * @property {number|null} nightlyCents room rate per night, before taxes
 * @property {number|null} nightlyInclCents Math.round(totalCents / nights)
 * @property {RowLine[]} lines supplier rows: a 'fee' line is always paid at the hotel, and is counted in totalCents
 * @property {number|null} totalCents
 * @property {'USD'} currency
 * @property {{ refundable: boolean, freeUntilHours: number, text: string }} cancellation supplier rows: text is
 *   source.TERMS.hotelNonRefundable, TERMS.hotelNoDeadline, or the supplier's own deadline
 * @property {string[]} amenities ≤ 4
 * @property {boolean} available
 * @property {boolean} demo not a real price: demo === (source.sourceOf(row) !== 'live') (dto.assertRow)
 * @property {string} pricedAt
 */

/** @typedef {FlightRow|HotelRow} Row */
/** The rows of one trip. @typedef {{ out: FlightRow, back: FlightRow|null, hotel: HotelRow|null }} TripRows */

/**
 * What a search left out, by reason (design §1.2, §3.2 to §3.5): the adapter's counts (DetailedSearch.skipped)
 * plus the composer's own (otherCurrency, currencies). Each count is a whole number ≥ 1; a reason that left
 * nothing out may be absent (read it as 0). Demo legs carry none.
 * @typedef {object} SkipCounts
 * @property {number} [mixedCabin] flight fares whose segments are in different cabins
 * @property {number} [firstCabin] first-class fares
 * @property {number} [unknownCarrier] fares with an owner, marketing or operating carrier that has no IATA code
 * @property {number} [timeMismatch] fares whose local times disagree with the segment duration
 * @property {number} [duplicateOption] a second fare or rate with the same option id in one offer (the cheaper is kept)
 * @property {number} [feeOtherCurrency] hotel rates with a fee paid at the hotel in another currency
 * @property {number} [noHotelData] hotels the supplier sent without hotel data (no name)
 * @property {number} [otherCurrency] (composer) rows priced in a currency other than USD, dropped from the search
 * @property {string[]} [currencies] (composer) those rows' currencies: ISO codes, sorted, no repeats
 */
/**
 * One flight leg of a search. A real supplier's failure throws from composer.search (503 'supplier_unavailable',
 * 429 'supplier_busy') instead of making a leg.
 * @typedef {object} FlightLegResult
 * @property {FlightRow[]} rows
 * @property {Benchmark} benchmark
 * @property {boolean} truncated
 * @property {SkipCounts} [skipped] real suppliers only
 */
/**
 * The hotel leg. Its benchmark depends on the policy's capBasis, so both are computed. When a real hotel
 * supplier fails, the composer catches it here: { rows: [], benchmark, truncated: false, error: 'unavailable' },
 * and the flights still show.
 * @typedef {object} HotelLegResult
 * @property {HotelRow[]} rows
 * @property {HotelBenchmarks} benchmark
 * @property {boolean} truncated
 * @property {SkipCounts} [skipped] real suppliers only
 * @property {'unavailable'|null} [error] the hotel supplier failed (absent or null otherwise)
 */
/** @typedef {{ incl_taxes: Benchmark, excl_taxes: Benchmark }} HotelBenchmarks */

/**
 * composer.search(query). Rows are sorted by totalCents (unavailable last). truncated: more than
 * search.MAX_PRICED_PER_LEG (60) options, the rest not priced.
 * @typedef {object} SearchResult
 * @property {TripQuery} query as searched: hotel.checkIn may have moved to the outbound arrival's local date.
 *   This, not the parsed form, is the query to price a selection with and to store on a request.
 * @property {{ out: FlightLegResult, back: FlightLegResult|null, hotel: HotelLegResult|null }} legs
 * @property {string} pricedAt the earliest time a supplier answered for any leg (offer details.answeredAt, so a
 *   cached answer keeps the supplier's time), else now() (demo)
 * @property {InventoryStatus} status
 */

/**
 * composer.price(selection, query, { previous, check }): every selected row priced again from the provider
 * (client prices are never trusted). totalCents is null when anything is unavailable. pricedAt as SearchResult's.
 * @typedef {{ rows: TripRows, totalCents: number|null, pricedAt: string, unavailable: Component[] }} PriceResult
 */

/**
 * A whole trip with one change (all_within: every out-of-policy component swapped), priced end to end
 * (composer.variants, plan §G1). `query` differs from the pick's only for kind 'dates'.
 * @typedef {object} TripVariant
 * @property {{ kind: ChangeKind, component: Component|'trip', fromText: string, toText: string, days?: number }} change
 *   fromText/toText: plain words with no amounts ("Business", "Premium economy"); days: the date shift (dates only)
 * @property {Selection} selection
 * @property {TripQuery} query
 * @property {TripRows} rows
 * @property {number} totalCents
 */

/** composer.variants(...). searches ≤ maxSearches (20); truncated when a cap cut anything. @typedef {{ candidates: TripVariant[], searches: number, truncated: boolean }} VariantResult */

/**
 * composer.recheck(request) / recheck.recheck(composer, request): the request's selection priced again now.
 * Writes nothing. status is the worst component status (unavailable > changed > same).
 * @typedef {object} RecheckResult
 * @property {'same'|'changed'|'unavailable'} status
 * @property {{ out: RecheckComponent, back: RecheckComponent|null, hotel: RecheckComponent|null }} components
 * @property {number|null} newTotalCents null when unavailable
 * @property {string} at
 */
/** @typedef {{ status: 'same'|'changed'|'unavailable', row: Row, wasCents: number, nowCents: number|null }} RecheckComponent row: the fresh row (available:false when gone) */

/**
 * The query the composer hands a Business flight provider (search, searchDetailed, getOffer, and quote's query).
 * @typedef {object} BusinessFlightQuery
 * @property {string} from IATA
 * @property {string} to IATA
 * @property {string} departDate 'YYYY-MM-DD'
 * @property {Cabin} cabin
 * @property {1} passengers
 * @property {CheckLevel} [check] price checks only (absent: 'auto'); demo providers and the fakes ignore it
 */

/**
 * The query the composer hands a Business hotel provider.
 * @typedef {object} BusinessHotelQuery
 * @property {string} where the searched city ('Cairo')
 * @property {string} [country] the searched country as the airport data names it ('Egypt'); a real supplier
 *   needs it (LiteAPI countryCode, through suppliers/places.js). Additive: the composer adds it
 * @property {string} checkIn
 * @property {string} checkOut
 * @property {1} guests
 * @property {CheckLevel} [check] price checks only (absent: 'auto')
 */

/**
 * What a real supplier adapter adds to a provider Offer's `details` (providers/contracts.js shapes). All
 * optional: demo offers have none of them, so demo rows are unchanged. offer.demo is true for demo and sandbox
 * offers (not a real price) and false only for live ones; dto copies it into row.demo.
 * @typedef {object} SupplierOfferDetails
 * @property {{ code: string, name: string }} [owner] flights: the airline selling the fare (Duffel offer.owner;
 *   'ZZ' is named "Test airline" in sandbox). dto.flightRow takes row.carrier from it when present
 * @property {Array<{ code: string, city: string }>} [via] flights: connection airports, then stops inside a
 *   segment, in travel order. dto.flightRow takes row.via from it when present
 * @property {number} [stops] flights: connections plus stops inside a segment (dto.flightRow already reads it)
 * @property {string} [answeredAt] ISO time the supplier answered (kept on a cache hit); the composer's pricedAt is
 *   the earliest of them
 */

/**
 * provider.searchDetailed(pq), an optional Business provider method (real suppliers only; demo providers and
 * the frozen fakes don't have it): search(pq)'s offers, plus what the adapter left out. The composer calls it
 * when the provider defines it, else search(pq).
 * @typedef {object} DetailedSearch
 * @property {object[]} offers provider Offers (validateOffer passes), as search(pq) would return them; offers in
 *   another currency are passed through (the composer drops and counts them)
 * @property {SkipCounts} skipped the adapter's own counts (never otherCurrency or currencies)
 * @property {boolean} truncated more options existed than the adapter kept (the cheapest search.MAX_PRICED_PER_LEG)
 */
/** @typedef {(pq: BusinessFlightQuery|BusinessHotelQuery) => Promise<DetailedSearch>} SearchDetailed */

/**
 * How the composer calls a Business provider beyond providers/contracts.js (both additive; demo providers and the
 * frozen fakes ignore the extra argument and field):
 * - `provider.getOffer(offerId, pq, { optionId })`: the optional third argument names the option the caller will
 *   quote, so a real supplier can check that one fare (DuffelFlights GETs that fare's Duffel offer at 'peek',
 *   'confirm' and 'final'). Without it a supplier re-searches instead of guessing a fare.
 * - `provider.quote({ offerId, optionId, query, offer })`: `offer` is the provider Offer the composer was just
 *   handed by search, searchDetailed or getOffer for the same query. A real supplier reads the quote from it
 *   locally (no second network call); without it, quote() calls getOffer itself. At `query.check === 'final'`
 *   LiteApiHotels.quote prebooks the room.
 * @typedef {{ optionId?: string|null }} GetOfferOpts
 * @typedef {{ offerId: string, optionId: string, query: BusinessFlightQuery|BusinessHotelQuery, offer?: object|null }} QuoteInput
 */

// =============================================================================================================
// 5. Policy evaluation (plan §E2 to §E4). Pure: no store, no clock (today is passed in).

/**
 * benchmark(values): the median of a search with outliers removed (n ≥ 4: outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR],
 * integer math). n < 3 → medianCents null.
 * @typedef {{ medianCents: number|null, sampleSize: number, excluded: number[] }} Benchmark
 *   sampleSize: values the median was taken over (after exclusion); excluded: the outliers left out, ascending
 */

/** @typedef {{ cents: number|null, source: 'route'|'fixed'|'median_pct'|'median_plus'|'fallback'|'none', haul: 'short'|'long', medianCents: number|null }} FlightCap */
/** @typedef {{ cents: number|null, source: 'city'|'country'|'default'|'none', basis: 'incl_taxes'|'excl_taxes' }} HotelCap */

/**
 * The inputs every evaluation shares.
 * @typedef {object} EvalCtx
 * @property {PolicyRules} rules
 * @property {{ tier: Tier, version: number }} policy
 * @property {OutOfPolicyMode} outOfPolicy the org setting
 * @property {string} today 'YYYY-MM-DD' in the org's time zone (tz.localDate(org.timezone, now))
 * @property {{ out?: Benchmark, back?: Benchmark, hotel?: Benchmark }} benchmarks hotel: the one on rules.hotels.capBasis
 * @property {Record<string, string>} carriers code → name (texts say "Sahara Wings", never "ZS")
 * @property {string} orgName ("Sahara Wings isn't used by Acme Inc")
 * @property {PriceSource} [priceSource] the rows' source (request or inventory); absent means 'demo'. Only texts
 *   depend on it, and demo texts are unchanged
 */

/**
 * The budget check of evaluateTrip. periodLabel is budgets.periodLabel(periodKey) ('Q4 2026'), filled in by
 * the caller so evaluate stays pure: "This trip would use $1,240 of the $900 left in Engineering for Q4 2026".
 * @typedef {{ remainingCents: number, periodKey: PeriodKey, periodLabel: string, departmentName: string }} BudgetCtx
 */

/**
 * One broken rule. rule is one of evaluate.RULE_IDS: 'flight.cap', 'flight.cabin', 'flight.advance',
 * 'flight.stops', 'flight.refundable', 'flight.carrier', 'hotel.cap', 'hotel.stars', 'hotel.advance',
 * 'hotel.refundable', 'trip.cap', 'budget', 'inventory.unavailable'.
 * @typedef {object} Violation
 * @property {string} rule
 * @property {Component|'trip'} component
 * @property {'approval'|'block'} severity block: flight.carrier and inventory.unavailable
 * @property {number|string|null} limit cents, days, stops, stars, a cabin or a carrier code. Money is what the rule
 *   compares: flight.cap the leg's cap and total; hotel.cap the WHOLE STAY on the cap basis (limit = nightly cap ×
 *   nights, actual = the stay's basis total), never per night; trip.cap and budget the trip total
 * @property {number|string|null} actual
 * @property {string} text plain English with amounts formatted by lib/money, no em dash
 */

/**
 * evaluateComponent(row, ctx).
 * @typedef {object} Evaluation
 * @property {PolicyStatus} status any block violation → blocked; else in 'block' mode any non-budget violation → blocked; else any → out
 * @property {Violation[]} violations
 * @property {{ cents: number|null, source: string, haul?: 'short'|'long', basis?: 'incl_taxes'|'excl_taxes' }} cap
 *   cents: a flight's cap, or a hotel's NIGHTLY cap (types.HotelCap)
 * @property {number} overCents how far over the cap, in the units the rule compares: a flight's total minus its
 *   cap; for a hotel the stay's basis total minus cap × nights (a stay total). 0 when within or no cap
 */

/**
 * evaluateTrip({ out, back, hotel }, ctx, { budget }). status: the worst component status, plus the trip
 * and budget violations (a budget-only overrun is 'out', never 'blocked').
 * @typedef {object} TripEvaluation
 * @property {PolicyStatus} status
 * @property {{ out: Evaluation, back?: Evaluation, hotel?: Evaluation }} components
 * @property {Violation[]} violations every component's, then trip.cap and budget
 * @property {number} totalCents
 * @property {{ tier: Tier, version: number }} policy
 * @property {string} [evaluatedAt] stamped by the service when stored
 */

/** A search row with its verdict (what the results page renders). @typedef {{ row: Row, evaluation: Evaluation }} ResultRow */

/**
 * One item of the "Your limits for this search" bar: `text`, then the amount (when cents is not null, in a
 * demo price chip), then `suffix`.
 * e.g. { key: 'flight.short', text: 'Flights under 6 hours: Economy, up to', cents: 71200,
 *        suffix: 'each way (median of these demo fares plus 20%)' }
 * On supplier prices only an amount worked out from the search (a median cap, a Price to Beat that is not only
 * the company's limit) gets the source chip: views/business/parts.fromSearch reads that from the suffix this
 * module writes, and test/business-policy.test.js pins the two together.
 * @typedef {{ key: string, text: string, cents: number|null, suffix: string }} LimitItem
 */
/** describe.limitsBar(...). @typedef {{ heading: string, items: LimitItem[] }} LimitsBar heading: 'Your limits for this search (Standard policy, v3)' */

/**
 * describe.describe(rules, opts): "Your travel policy" in plain words.
 * @typedef {{ title: string, sub: string, lines: string[] }} PolicyDescription title 'Your travel policy', sub 'Standard policy, version 3'
 */

// =============================================================================================================
// 6. Alternatives and their explanation (plan §G)

/**
 * A cheaper way to make the trip (alternatives.buildAlternatives). id = sha256 of the selection and query,
 * 16 hex characters. label holds no digits and no currency signs (nor do the explainer's notes and summary).
 * giveUps may hold times, counts and percentages ('Leaves 07:05 instead of 13:40', '1 checked bag instead of
 * 2', 'Refunds nothing (yours refunds 70%)') but never an amount of money or a currency sign.
 * @typedef {object} Alternative
 * @property {string} id
 * @property {ChangeKind} kind
 * @property {string} label e.g. 'Same flight, Classic fare'
 * @property {TripVariant['change']} change
 * @property {Selection} selection
 * @property {TripQuery} query
 * @property {TripRows} rows
 * @property {number} totalCents Σ rows
 * @property {number} savesCents pick total − totalCents, ≥ alternatives.MIN_SAVING_CENTS (100)
 * @property {TripEvaluation} evaluation
 * @property {string[]} giveUps diff.giveUps(pick rows, these rows), e.g. 'Leaves 07:05 instead of 13:40'
 * @property {string} note the explainer's note for it ('' until explained)
 */

/**
 * buildAlternatives' input. evaluate(variant) returns the variant's TripEvaluation (the caller closes over ctx and budget).
 * @typedef {object} AlternativesInput
 * @property {{ selection: Selection, query: TripQuery, rows: TripRows, totalCents: number }} pick
 * @property {TripEvaluation} pickEval
 * @property {TripVariant[]} candidates
 * @property {(variant: TripVariant) => TripEvaluation} evaluate
 * @property {boolean} truncated from composer.variants
 */

/**
 * buildAlternatives' result: ≤ 5, within policy first, then savesCents descending, fewer give-ups, smaller
 * date shift, id. cheapestWithin is pinned first when it exists.
 * @typedef {{ alternatives: Alternative[], cheapestWithin: Alternative|null, noneWithin: boolean, truncated: boolean }} AlternativesResult
 */

/**
 * What an explainer sees: no prices, no totals, no names.
 * @typedef {object} ExplainInput
 * @property {Array<{ rule: string }>} violations
 * @property {Array<{ id: string, kind: ChangeKind, withinPolicy: boolean, savingsRank: number, giveUps: string[] }>} alternatives
 * @property {boolean} noneWithin
 */

/**
 * What an explainer returns, after explain.guardExplanation: known ids only (missing ones appended in input
 * order); notes ≤ 160 and summary ≤ 300 characters; any text matching /[0-9]|[$€£¥]|\bUSD\b/ dropped.
 * @typedef {{ order: string[], notes: Record<string, string>, summary: string }} ExplainOutput
 */

/**
 * The pluggable explainer (explain.RuleExplainer today; a model may plug in later on the owner's word).
 * @typedef {{ name: string, explain: (input: ExplainInput, opts: { signal: AbortSignal }) => Promise<ExplainOutput> }} AlternativesExplainer
 */

/**
 * What the service holds (explain.createExplainer): runs the configured explainer under a 200 ms timeout
 * and guardExplanation, and falls back to RuleExplainer's output on a throw or timeout. Never rejects.
 * @typedef {{ name: string, explain: (input: ExplainInput) => Promise<ExplainOutput> }} GuardedExplainer
 */

/**
 * diff.compareTrips(a, b): "Requested vs cheapest option inside policy". rows list only what differs,
 * in a declared order (diff.DIFF_FIELDS: carrier, times, stops, cabin, fare, bags, refunds, changes, hotel, room,
 * stars, hotelRefunds, dates), one row per field and flight leg that differs. 'changes' is the fare's change
 * terms and 'hotelRefunds' the hotel's cancellation terms.
 * @typedef {object} TripComparison
 * @property {Array<{ label: string, a: string|null, b: string|null }>} rows
 * @property {{ a: number, b: number, delta: number }} totalCents delta = b − a
 */

// =============================================================================================================
// 7. Approvals (plan §C5, §D)

/**
 * approver.resolveApprover(traveler, membersById). Valid = an active member holding approval.decide who is
 * not the traveler. Order: traveler.approverId, traveler.managerId, then the pool (active owners and travel
 * admins other than the traveler, earliest `at` first; approverId null, pool true, rule 'admin').
 * @typedef {object} ApproverResolution
 * @property {string|null} approverId
 * @property {boolean} pool
 * @property {string[]} poolIds
 * @property {'approver'|'manager'|'admin'|null} rule null when nobody can approve (submit → 422 no_approver)
 * @property {Array<{ userId: string, reason: 'not_member'|'removed'|'cannot_approve'|'is_traveler' }>} skipped
 */

/**
 * The fields a re-price or a swap writes on a draft (built by the service from composer and policy output).
 * @typedef {object} DraftFields
 * @property {TripQuery} query
 * @property {Selection} selection
 * @property {TripRows} rows
 * @property {string} pricedAt
 * @property {number} totalCents
 * @property {TripEvaluation} evaluation
 * @property {Alternative[]} alternatives
 * @property {boolean} alternativesTruncated
 * @property {Alternative|null} cheapestWithin
 * @property {RequestExplanation|null} explanation
 */

/**
 * The budget a submit or an approval would hold against (budgets.js; null when the department has no
 * budget for the period: no hold and no budget violation).
 * @typedef {object} BudgetPreview
 * @property {string} budgetId
 * @property {string} departmentId
 * @property {string} departmentName
 * @property {PeriodKey} periodKey
 * @property {string} periodLabel 'Q4 2026' or 'November 2026'
 * @property {number} amountCents
 * @property {number} committedCents Σ commits (this request's own hold excluded)
 * @property {number} remainingCents amount − committed (may be negative)
 * @property {number} rev the budget record's rev when read
 */

/**
 * The events of lifecycle.transition (plan §C5 table). `draft` carries the re-priced fields when the
 * re-check (opts.recheck) or a swap changed them.
 * @typedef {{ type: 'swap', alternative: Alternative, draft: DraftFields }
 *   | { type: 'submit', reason: RequestReason|null, approver: ApproverResolution|null, budget: BudgetPreview|null, draft: DraftFields|null }
 *   | { type: 'cancel' }
 *   | { type: 'approve', note: string, ackOverBudget: boolean, budget: BudgetPreview|null, draft: DraftFields|null }
 *   | { type: 'deny', note: string }
 *   | { type: 'expire' }
 *   | { type: 'message', text: string }} LifecycleEvent
 */

/**
 * lifecycle.transition's options.
 * @typedef {object} TransitionOpts
 * @property {string} now ISO time from the injected clock
 * @property {ActorRef} actor
 * @property {Member|null} member the acting member (null for system events); its role decides override
 * @property {boolean} [pooled] the actor holds a pool link for this request
 * @property {Org} org settings (reasonMinChars, outOfPolicy, approvalHours) and timezone
 * @property {TripEvaluation} [evaluation] the fresh evaluation (submit, approve)
 * @property {RecheckResult} [recheck] the fresh price check (submit, approve)
 */

/**
 * lifecycle.transition's result: the fields to write (the CAS fn assigns them onto the fresh document) and
 * the history line to append (null for 'message').
 * @typedef {{ next: Partial<Request>, history: HistoryEntry|null, outcome: string }} TransitionResult
 *   outcome: 'swapped'|'repriced'|'auto_approved'|'submitted'|'cancelled'|'approved'|'returned'|'denied'|'expired'|'message'
 */

// =============================================================================================================
// 8. Budgets, reports, CSV (plan §C6, §H4 to §H7)

/**
 * One department's line on /budgets (budgets.listBudgets). Money tiles are demo-labelled by the view.
 * @typedef {object} BudgetRow
 * @property {{ id: string, name: string, archived: boolean }} department
 * @property {PeriodKey} periodKey
 * @property {string|null} budgetId null when no budget is set for the period
 * @property {number|null} amountCents
 * @property {number} committedCents Σ holds of approved requests
 * @property {number} awaitingCents Σ totals of pending requests (never counted as committed)
 * @property {number|null} remainingCents amount − committed (null without a budget)
 * @property {'USD'} currency
 * @property {number|null} rev the budget record's rev (for the edit form)
 * @property {boolean} truncated the pending scan hit constants.SCAN_CAP
 */

/** A "Coming soon" tile: never a number, never $0 (reports.COMING_SOON). @typedef {{ key: string, label: string }} ComingSoonTile */

/** @typedef {{ tenths: number|null, submitted: number, outOrBlocked: number }} OutOfPolicyShare tenths null when nothing was submitted */
/** @typedef {{ rule: string, label: string, count: number }} ReasonCount */

/**
 * The reports tiles for one period (reports.js, pure over paged records).
 * @typedef {object} ReportTiles
 * @property {Record<EffectiveStatus, number>} byStatus
 * @property {OutOfPolicyShare} outOfPolicyShare
 * @property {ReasonCount[]} topReasons ≤ 5
 * @property {BudgetRow[]} committedVsBudget
 * @property {number} savedBySwitchingCents Σ (originalTotalCents − totalCents) over approved requests with swaps
 * @property {Array<{ userId: string, name: string, requests: number, committedCents: number }>} byTraveler
 * @property {ComingSoonTile[]} comingSoon
 * @property {boolean} truncated "Based on the 5,000 most recent requests"
 * @property {PriceSource|null} [priceSource] where the counted requests' prices came from (reports.totalsSource):
 *   'sandbox' when any of them is supplier test data ("Includes supplier test data"), else the least real
 *   (source.leastReal); null when none is counted
 */

/**
 * The setup checklist (Owner and Travel Admin home, /welcome), ticked from data.
 * @typedef {{ policyReviewed: boolean, departments: boolean, invited: boolean, demoTrip: boolean }} Checklist
 */

/**
 * service.dashboard(actor, { periodKey, view }). Sections the member's role does not reach are null.
 * @typedef {object} DashboardView
 * @property {Role} role
 * @property {PeriodKey} periodKey
 * @property {string} periodLabel
 * @property {Checklist|null} checklist owner, travel admin
 * @property {{ count: number, rows: InboxRow[] }|null} waiting approval.decide: the 5 oldest waiting for you
 * @property {RequestRow[]} myTrips the 5 newest of the member's own
 * @property {RequestRow[]|null} teamTrips request.view.team: the 5 newest team requests (roles.allowed with
 *   'request.view.team', the member's own left out) departing in the period, for the Manager home's "team trips
 *   this period"
 * @property {PolicyDescription} policy the member's own tier at a glance
 * @property {{ count: number }|null} pendingCompany request.view.all
 * @property {OutOfPolicyShare|null} outOfPolicyShare reports.view
 * @property {ReasonCount[]|null} topReasons reports.view
 * @property {AuditEntry[]|null} recent audit.view: the 5 newest
 * @property {BudgetRow[]|null} budgets budget.view.dept (own department) or budget.view.all
 * @property {ReportTiles|null} reports view 'reports' only (reports.view)
 * @property {PriceSource|null} [priceSource] the source of the totals this page shows (the period's counted
 *   requests and the rows it lists), by the same rule as ReportTiles.priceSource; null when it counts none
 */

/**
 * service.exportCsv(...): a UTF-8 CSV with a BOM, columns csv.CSV_COLUMNS, cells guarded against formula
 * injection. filename 'tripelyx-requests-2026-Q4.csv'.
 * @typedef {{ filename: string, body: string, rowCount: number, truncated: boolean }} CsvExport
 */

/**
 * service.exportCompany(actor). filename 'tripelyx-company-<org id>.json'. In `json`, each request carries
 * `price_source` ('Demo price', 'Supplier test data' or 'Supplier price', the CSV's words), and the note is
 * team.EXPORT_NOTES.demo when every request is demo (or there are none), else EXPORT_NOTES.supplier ("from demo
 * prices, supplier test data or supplier prices, as each request's price_source says").
 * @typedef {{ filename: string, json: string }} CompanyExport
 */

// =============================================================================================================
// 9. What the service methods return to routes (view models)

/**
 * A page of records. cursor is opaque (Repo.page); null on the last page. A foreign or damaged cursor is a 404.
 * @template T
 * @typedef {{ rows: T[], cursor: string|null }} Page
 */

/** A company in the switcher and on /business/app. @typedef {{ id: string, name: string, status: OrgStatus, role: Role, roleLabel: string }} CompanyLink */

/**
 * A row of a request list (/trips, reports, the dashboard).
 * @typedef {object} RequestRow
 * @property {string} id
 * @property {string} travelerId
 * @property {string} travelerName
 * @property {string|null} departmentId
 * @property {string} from
 * @property {string} to
 * @property {string} departDate
 * @property {string|null} returnDate
 * @property {string|null} hotelCity
 * @property {number} totalCents
 * @property {'USD'} currency
 * @property {string} pricedAt
 * @property {EffectiveStatus} status
 * @property {PolicyStatus} policyStatus
 * @property {string} at
 * @property {PriceSource} source source.requestSource(request): 'demo' for a request stored before real suppliers
 */

/**
 * A row of the approvals inbox.
 * @typedef {RequestRow & { violationsCount: number, waitingSince: string, expiresAt: string|null,
 *   decidedAs: 'assigned'|'pool'|'override'|null }} InboxRow
 */

/**
 * service.inbox(actor, { tab, cursor }). Tabs: 'waiting' ("Waiting for you", oldest first), 'decided'
 * ("Decided by you": the member's 'decider' links, so override decisions show too), 'company' (override
 * holders: every pending request; null count otherwise), 'expired' (no actions).
 * @typedef {{ tab: 'waiting'|'decided'|'company'|'expired', counts: { waiting: number, decided: number,
 *   company: number|null, expired: number }, rows: InboxRow[], cursor: string|null }} InboxView
 */

/**
 * What the results page needs (service.searchTrip). Rows are evaluated and ordered within → out → blocked,
 * then total, departure time, offer id.
 * @typedef {object} SearchView
 * @property {InventoryStatus} status
 * @property {TripQuery} query
 * @property {{ tier: Tier, version: number }} policy
 * @property {string} tierLabel
 * @property {string|null} departmentName
 * @property {LimitsBar} limits
 * @property {{ out: LegView, back: LegView|null, hotel: HotelLegView|null }} legs
 * @property {string} pricedAt
 * @property {string[]} blockedCarrierNames for the banner ("Sahara Wings isn't used by Acme Inc. …")
 */
/**
 * One leg of the results page.
 * @typedef {object} LegView
 * @property {ResultRow[]} rows
 * @property {number} outsideCount out-of-policy plus blocked rows
 * @property {boolean} truncated
 * @property {Benchmark} benchmark
 * @property {SkipCounts} [skipped] from the leg (real suppliers): the per-cause notices
 * @property {'unavailable'|null} [error] hotel leg only: the hotel supplier failed ("Hotels are not available right
 *   now. You can still request the flights.")
 */
/** @typedef {LegView & { city: string, country: string, priceToBeatCents: number|null }} HotelLegView */

/**
 * service.getRequest(actor, rid). `can` drives the buttons; the service re-checks on every POST anyway.
 * @typedef {object} RequestView
 * @property {Request} request
 * @property {EffectiveStatus} status
 * @property {boolean} self the viewer is the traveler
 * @property {{ swap: boolean, submit: boolean, cancel: boolean, decide: boolean, override: boolean, message: boolean }} can
 * @property {{ userId: string, name: string, rule: 'approver'|'manager'|'admin'|null }|null} approver for "Goes to Dana Lee (your manager)"
 * @property {BudgetPreview|null} budget draft: the preview; pending: the impact; approved: the hold's budget
 * @property {RecheckResult|null} live deciders only, on GET (writes nothing)
 * @property {LiveCheckError|null} [liveError] deciders only, on GET: why live is null when the check could not answer.
 *   'live_check_skipped': "The price is checked again when you approve."; any other: "We couldn't check the price
 *   just now. It is checked again when you approve." (source.PRICE_CHECK_COPY). Absent or null when it answered
 * @property {TripComparison|null} comparison deciders only: requested vs cheapestWithin
 * @property {{ from: number, to: number }|null} policyChanged the tier's policy moved on since the evaluation
 * @property {string} timezone the org's, for every time on the page
 */

/** service.submit(...). @typedef {{ request: Request, outcome: 'auto_approved'|'submitted'|'repriced' }} SubmitResult */
/** service.decide(...). 'expired' is persisted and then answered 409. @typedef {{ request: Request, outcome: 'approved'|'denied'|'returned' }} DecideResult */

/**
 * A member as the People page shows them. email only with members.manage (else null).
 * @typedef {object} MemberView
 * @property {string} userId
 * @property {string} name
 * @property {string|null} email
 * @property {Role} role
 * @property {string} roleLabel
 * @property {MemberStatus} status
 * @property {{ id: string, name: string }|null} department
 * @property {{ userId: string, name: string }|null} manager
 * @property {{ userId: string, name: string }|null} approver
 * @property {Tier} tier
 * @property {string} at
 * @property {number} rev
 */

/** A pending invite on the People page (members.manage). @typedef {{ publicId: string, email: string, role: Role, roleLabel: string, departmentName: string|null, expiresAt: string, at: string }} InviteView */

/**
 * service.listMembers(actor, { cursor }). invites null without members.manage. warnings: plain English,
 * e.g. "Sam Traveler has no one who can approve their trips".
 * @typedef {{ members: MemberView[], cursor: string|null, invites: InviteView[]|null, departments: Department[],
 *   warnings: string[], memberCount: number }} PeopleView
 */

/**
 * service.invite(...): the token is shown once on the copy-link page and never stored.
 * @typedef {{ token: string, invite: InviteView, replaced: boolean, orgName: string }} InviteCreated
 */

/**
 * service.inviteByToken({ user }, token): the invite landing. state:
 *   'join'            signed out (whether or not an account uses the email: the landing never looks it up, so a
 *                     link never reveals whether an address has an account) → "Create your account" (the /join
 *                     form) plus "Already have an account? Sign in" (/business/signin?next=<this landing>).
 *                     POST /join answers "This email already has an account. Sign in instead." behind bizAuthIp.
 *   'accept'          signed in with the invited email → join
 *   'other_email'     signed in with another email → refused (copy in plan §B6)
 *   'member'          already an active member → link to the workspace
 *   'pending_company' the company is not confirmed yet → 409 page
 * Throws AppError 410 'invite_gone' for an unknown, expired, revoked, replaced or used token.
 * @typedef {object} InviteLanding
 * @property {{ id: string, name: string, status: OrgStatus, timezone: string }} org timezone: the company's, so the
 *   landing says the expiry in company time, as the invite link page and People do
 * @property {{ publicId: string, email: string, emailMasked: string, role: Role, roleLabel: string,
 *   departmentName: string|null, invitedByName: string, expiresAt: string }} invite
 * @property {'join'|'accept'|'other_email'|'member'|'pending_company'} state
 */

/**
 * service.getPolicy(actor, tier). form is formFromPolicy(rules) for policy.edit holders (else null).
 * @typedef {object} PolicyView
 * @property {Tier} tier
 * @property {string} tierLabel
 * @property {number} version
 * @property {PolicyRules} rules
 * @property {PolicyDescription} description
 * @property {string} updatedAt
 * @property {ActorRef} updatedBy
 * @property {number} rev
 * @property {boolean} canEdit
 * @property {boolean} defaults still version 1 ("Starting rules suggested by Tripelyx")
 * @property {PolicyForm|null} form
 * @property {{ airports: Array<{ code: string, city: string, country: string }>, carriers: Array<{ code: string, name: string }>,
 *   countries: string[] }} refs for the editor's choices
 */

/** service.policyHistory(actor, tier, { before }). older: the `before` value of the next page, or null. @typedef {{ tier: Tier, versions: PolicyVersion[], older: number|null }} PolicyHistoryView */

/**
 * A company on /admin/business (platform admins). No requests, policies, budgets, member lists or audit contents.
 * @typedef {object} PlatformOrgRow
 * @property {string} id
 * @property {string} name
 * @property {OrgStatus} status
 * @property {string} size
 * @property {string} at
 * @property {string} creatorEmail
 * @property {number} memberCount
 * @property {string} timezone
 * @property {string[]} similarNames names of other companies with the same nameKey
 * @property {string|null} statusNote the note of the last status change (the pause note; staff only)
 * @property {string|null} statusAt when the status last changed
 * @property {string|null} previousName the name Tripelyx confirmed before a rename sent the company back to 'pending'
 * @property {number} rev
 */

/** service.platformListOrgs({ user }): pending first, then active, then suspended. leads: kind 'business' only (≤ 200). @typedef {{ orgs: PlatformOrgRow[], leads: object[] }} PlatformView */

/**
 * What the workspace shell needs (http.shellContext; frozen in Stage 0).
 * @typedef {{ org: Org, member: Member, companies: CompanyLink[], approvalsCount: number|null,
 *   nav: Array<{ key: string, label: string, href: string, current: boolean }> }} ShellModel
 */

// =============================================================================================================
// 10. The service's dependencies (plan §J). Service modules reach the policy engine, the composer, the
//     alternatives and the explainer ONLY through `this.*`, so tests can hand in test/business-fakes.js.

/**
 * inventory.createBusinessInventory(config, { registry, overrides, fetch, now, log }). status 'none' (production
 * today): flights and hotels null, airports() and carriers() empty, cityFor() null. A configured real supplier
 * that cannot work (a problem) gives 'none' with `problem` set, never demo.
 * @typedef {object} BusinessInventory
 * @property {InventoryStatus} status
 * @property {object|null} flights a FlightProvider (providers/contracts.js): BusinessDemoFlights in demo,
 *   suppliers/duffel.js DuffelFlights in sandbox
 * @property {object|null} hotels a HotelProvider: BusinessDemoHotels in demo, suppliers/liteapi.js LiteApiHotels in
 *   sandbox; null when no hotel supplier works (never demo hotels next to supplier flights)
 * @property {() => Array<{ code: string, name: string, city: string, country: string, tz: string }>} airports
 * @property {() => Array<{ code: string, name: string }>} carriers in sandbox: suppliers/airlines.js plus
 *   { code: 'ZZ', name: 'Test airline' }, never the demo carriers
 * @property {(iata: string) => { city: string, country: string }|null} cityFor DBB → New Alamein, CAI → Cairo
 * @property {PriceSource|null} [source] where its prices come from; null for status 'none'. Absent (the frozen
 *   fakes): 'demo' for status 'demo', 'live' for 'live', null for 'none'
 * @property {boolean} [hotelsConnected] false when flights work but hotels don't ("Hotels are not connected
 *   yet"). Absent: hotels !== null
 * @property {number} [maxVariantSearches] the provider searches composer.variants may spend (4 by default for real
 *   suppliers, BUSINESS_SUPPLIER_VARIANT_SEARCHES; search.MAX_SEARCHES 20 for demo). Absent: MAX_SEARCHES
 * @property {string|null} [problem] why a configured supplier is off, for platform admins on /admin/business: a
 *   short sentence that names the variable, never its value or any part of it. null when none; absent means null
 */

/**
 * search.TripComposer (new TripComposer({ inventory, now })). Writes nothing, ever.
 * @typedef {object} TripComposer
 * @property {(raw: RawTripQuery, opts: { today: string }) => TripQuery} parseQuery search.parseTripQuery with
 *   this inventory's airports; 422 'invalid_query' with per-field details
 * @property {(query: TripQuery) => Promise<SearchResult>} search 503 'no_supplier' when status is 'none'; a real
 *   flight supplier's failure throws 503 'supplier_unavailable' or 429 'supplier_busy' (a hotel failure is the
 *   hotel leg's error instead). Rows in another currency are dropped and counted (leg skipped.otherCurrency),
 *   never a 422 for the whole search
 * @property {(selection: Selection, query: TripQuery, opts?: { previous?: TripRows|null, check?: CheckLevel }) => Promise<PriceResult>} price
 *   422 'invalid_selection' for malformed keys; 422 'unsupported_currency' for a selected row in another
 *   currency; check (default 'auto') goes to the provider as pq.check
 * @property {(query: TripQuery, selection: Selection, opts: { datesFlexible: boolean, maxSearches?: number }) => Promise<VariantResult>} variants
 *   maxSearches is also capped by inventory.maxVariantSearches
 * @property {(request: Request, opts?: { check?: CheckLevel }) => Promise<RecheckResult>} recheck
 *   recheck.recheck(this, request, opts); 503 'live_check_skipped' for a 'peek' that would need a search
 */

/**
 * The pure rules 1P builds, as one object (policy/index.createPolicyEngine()). The service calls them as
 * this.policy.x(...).
 * @typedef {object} PolicyEngine
 * @property {(form: PolicyForm, refs: PolicyRefs) => PolicyRules} normalizePolicy 422 'invalid_policy' with per-field details
 * @property {(rules: PolicyRules) => PolicyForm} formFromPolicy normalizePolicy(formFromPolicy(r), refs) deep-equals r
 * @property {(before: PolicyRules, after: PolicyRules) => Change[]} policyChanges declared paths, in order
 * @property {(values: number[]) => Benchmark} benchmark
 * @property {(rows: FlightRow[]) => number[]} flightValues one per itinerary: its cheapest available total
 * @property {(rows: HotelRow[], basis: 'incl_taxes'|'excl_taxes') => number[]} hotelValues one per hotel: its cheapest available nightly
 * @property {(rules: PolicyRules, row: FlightRow, benchmark: Benchmark|null) => FlightCap} flightCap
 * @property {(rules: PolicyRules, row: HotelRow) => HotelCap} hotelCap
 * @property {(row: Row, ctx: EvalCtx) => Evaluation} evaluateComponent
 * @property {(rows: { out: FlightRow, back?: FlightRow|null, hotel?: HotelRow|null }, ctx: EvalCtx, opts: { budget: BudgetCtx|null }) => TripEvaluation} evaluateTrip
 * @property {(capCents: number|null, hotelBenchmark: Benchmark|null) => number|null} priceToBeat
 * @property {(rules: PolicyRules, opts: { tier: Tier, version: number, orgName: string, carriers: Record<string, string>, demo?: boolean, source?: PriceSource|null }) => PolicyDescription} describe
 *   demo (default true) says "the demo fares"; source, when given, wins ('sandbox': "the test fares", 'live': "the fares")
 * @property {(rules: PolicyRules, ctx: EvalCtx, search: SearchResult) => LimitsBar} limitsBar
 * @property {(traveler: Member, membersById: Record<string, Member>) => ApproverResolution} resolveApprover
 * @property {(request: Request, event: LifecycleEvent, opts: TransitionOpts) => TransitionResult} transition
 * @property {(request: Request, nowIso: string, timezone?: string) => EffectiveStatus} effectiveStatus
 * @property {(submittedAt: string, approvalHours: number, departDate: string, timezone: string) => string} expiresAt
 */

/**
 * alternatives.js and diff.js, as the service holds them.
 * @typedef {object} AlternativesEngine
 * @property {(input: AlternativesInput) => AlternativesResult} buildAlternatives
 * @property {(a: { rows: TripRows, totalCents: number }, b: { rows: TripRows, totalCents: number }) => TripComparison} compareTrips
 */

/**
 * new BusinessService(deps) (service.js). app.js builds every one when ENABLE_BUSINESS is on.
 * @typedef {object} BusinessDeps
 * @property {import('./repo').Repo} repo the only way to the store
 * @property {object|null} accounts server/accounts Accounts (register, authenticate, createSession, …)
 * @property {object} config the app config (config.business)
 * @property {() => Date} now the injected clock
 * @property {{ info?: Function, warn: Function, error: Function }} log
 * @property {BusinessInventory} inventory
 * @property {TripComposer} composer
 * @property {PolicyEngine} policy
 * @property {AlternativesEngine} alternatives
 * @property {GuardedExplainer} explainer
 */

// =============================================================================================================
// 11. Routes (plan §B4, §I7)

/**
 * One entry of a router's ROUTES table. The Stage 3 structural test walks the Express stack and fails on
 * any route not listed here; every '/o/:orgId' route must run bizMemberGate before its last handler.
 * @typedef {object} RouteEntry
 * @property {'GET'|'POST'} method
 * @property {string} path relative to the router's MOUNT, e.g. '/o/:orgId/trips/:rid/decide'
 * @property {Permission|Permission[]|null} perm what memberGate checks (null: no company permission)
 * @property {false|'request'} own memberGate's own option
 * @property {LimiterName[]} limiter in mount order ('bizAuthAccount' always runs after the form parser)
 * @property {'anyone'|'user'|'member'|'platform'} who anyone: no sign-in; user: signed in; member: memberGate;
 *   platform: req.user.isAdmin (404 otherwise)
 */

/**
 * What app.js hands every Business router (routes/business/index.createRouterDeps).
 * @typedef {object} RouterDeps
 * @property {{ bizAuthIp: Function, bizAuthAccount: Function, bizWrite: Function, bizCompute: Function }} limits
 *   limits.createBusinessLimits(config.business), built once per app
 * @property {Function} sameOrigin routes/trips.sameOrigin
 * @property {Function} form the Business form parser (url-encoded, 64 kb, 4,000 fields: the policy editor is large)
 * @property {{ info?: Function, warn: Function, error: Function }} log
 */

module.exports = {};
