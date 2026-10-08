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
/** @typedef {'demo'|'live'|'none'} InventoryStatus */
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
 * @typedef {{ orgId: string, requestId: string, userId: string, role: 'traveler'|'approver'|'pool', at: string }} ReqLink
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
 * Set when an automatic re-check sent a pending request back to draft (or a draft's price moved on submit).
 * @typedef {{ at: string, why: 'price_changed'|'unavailable', fromCents: number, toCents: number|null }} RequestReturned
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
 * @property {true} demo
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
 * @property {string} offerId
 * @property {string} optionId fare family code: 'LIGHT'|'CLASSIC'|'FLEX' in the demo
 * @property {{ code: string, name: string }} carrier the itinerary's carrier
 * @property {string[]} flightNumbers
 * @property {RowSegment[]} segments
 * @property {number} stops
 * @property {Array<{ code: string, city: string }>} via connection airports
 * @property {number} flyingMinutes Σ segment durationMinutes (layovers excluded; decides the haul)
 * @property {number} elapsedMinutes first departure to last arrival, in UTC
 * @property {Cabin} cabin
 * @property {'Economy'|'Premium economy'|'Business'} cabinLabel
 * @property {{ code: string, name: string, cabinKg: number, checkedBags: number, checkedKg: number,
 *   changeable: boolean, refundablePercent: number, terms: string }} fare
 * @property {RowLine[]} lines
 * @property {number|null} totalCents Σ lines
 * @property {'USD'} currency
 * @property {boolean} available
 * @property {true} demo
 * @property {string} pricedAt
 */

/**
 * One room of one hotel (dto.HOTEL_ROW_KEYS is the exact allow-list). No rating, reviews, provider or net rates.
 * @typedef {object} HotelRow
 * @property {string} key 'h.' + offerId + '|' + optionId
 * @property {'hotel'} kind
 * @property {string} offerId
 * @property {string} optionId room code
 * @property {string} name
 * @property {number} stars
 * @property {string} area
 * @property {string} city
 * @property {string} country
 * @property {{ name: string, sleeps: number, bed: string }} room
 * @property {string} checkIn
 * @property {string} checkOut
 * @property {number} nights
 * @property {number|null} nightlyCents room rate per night, before taxes
 * @property {number|null} nightlyInclCents Math.round(totalCents / nights)
 * @property {RowLine[]} lines
 * @property {number|null} totalCents
 * @property {'USD'} currency
 * @property {{ refundable: boolean, freeUntilHours: number, text: string }} cancellation
 * @property {string[]} amenities ≤ 4
 * @property {boolean} available
 * @property {true} demo
 * @property {string} pricedAt
 */

/** @typedef {FlightRow|HotelRow} Row */
/** The rows of one trip. @typedef {{ out: FlightRow, back: FlightRow|null, hotel: HotelRow|null }} TripRows */

/** One flight leg of a search. @typedef {{ rows: FlightRow[], benchmark: Benchmark, truncated: boolean }} FlightLegResult */
/**
 * The hotel leg. Its benchmark depends on the policy's capBasis, so both are computed.
 * @typedef {{ rows: HotelRow[], benchmark: HotelBenchmarks, truncated: boolean }} HotelLegResult
 */
/** @typedef {{ incl_taxes: Benchmark, excl_taxes: Benchmark }} HotelBenchmarks */

/**
 * composer.search(query). Rows are sorted by totalCents (unavailable last). truncated: more than
 * search.MAX_PRICED_PER_LEG (60) options, the rest not priced.
 * @typedef {object} SearchResult
 * @property {TripQuery} query as searched: hotel.checkIn may have moved to the outbound arrival's local date
 * @property {{ out: FlightLegResult, back: FlightLegResult|null, hotel: HotelLegResult|null }} legs
 * @property {string} pricedAt
 * @property {InventoryStatus} status
 */

/**
 * composer.price(selection, query): every selected row priced again from the provider (client prices are
 * never trusted). totalCents is null when anything is unavailable.
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
 */

/** The budget check of evaluateTrip. @typedef {{ remainingCents: number, periodKey: PeriodKey, departmentName: string }} BudgetCtx */

/**
 * One broken rule. rule is one of evaluate.RULE_IDS: 'flight.cap', 'flight.cabin', 'flight.advance',
 * 'flight.stops', 'flight.refundable', 'flight.carrier', 'hotel.cap', 'hotel.stars', 'hotel.advance',
 * 'hotel.refundable', 'trip.cap', 'budget', 'inventory.unavailable'.
 * @typedef {object} Violation
 * @property {string} rule
 * @property {Component|'trip'} component
 * @property {'approval'|'block'} severity block: flight.carrier and inventory.unavailable
 * @property {number|string|null} limit cents, days, stops, stars, a cabin or a carrier code
 * @property {number|string|null} actual
 * @property {string} text plain English with amounts formatted by lib/money, no em dash
 */

/**
 * evaluateComponent(row, ctx).
 * @typedef {object} Evaluation
 * @property {PolicyStatus} status any block violation → blocked; else in 'block' mode any non-budget violation → blocked; else any → out
 * @property {Violation[]} violations
 * @property {{ cents: number|null, source: string, haul?: 'short'|'long', basis?: 'incl_taxes'|'excl_taxes' }} cap
 * @property {number} overCents how far over the cap (0 when within or no cap)
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
 * 16 hex characters. label and giveUps hold no digits and no currency signs.
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
 * in a declared order (carrier, times, stops, cabin, fare, bags, refunds, hotel, room, stars, dates).
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
 * @property {PolicyDescription} policy the member's own tier at a glance
 * @property {{ count: number }|null} pendingCompany request.view.all
 * @property {OutOfPolicyShare|null} outOfPolicyShare reports.view
 * @property {ReasonCount[]|null} topReasons reports.view
 * @property {AuditEntry[]|null} recent audit.view: the 5 newest
 * @property {BudgetRow[]|null} budgets budget.view.dept (own department) or budget.view.all
 * @property {ReportTiles|null} reports view 'reports' only (reports.view)
 */

/**
 * service.exportCsv(...): a UTF-8 CSV with a BOM, columns csv.CSV_COLUMNS, cells guarded against formula
 * injection. filename 'tripelyx-requests-2026-Q4.csv'.
 * @typedef {{ filename: string, body: string, rowCount: number, truncated: boolean }} CsvExport
 */

/** service.exportCompany(actor). filename 'tripelyx-company-<org id>.json'. @typedef {{ filename: string, json: string }} CompanyExport */

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
 */

/**
 * A row of the approvals inbox.
 * @typedef {RequestRow & { violationsCount: number, waitingSince: string, expiresAt: string|null,
 *   decidedAs: 'assigned'|'pool'|'override'|null }} InboxRow
 */

/**
 * service.inbox(actor, { tab, cursor }). Tabs: 'waiting' ("Waiting for you", oldest first), 'decided'
 * ("Decided by you"), 'company' (override holders: every pending request; null count otherwise),
 * 'expired' (no actions).
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
/** @typedef {{ rows: ResultRow[], outsideCount: number, truncated: boolean, benchmark: Benchmark }} LegView outsideCount: out-of-policy plus blocked rows */
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
 *   'join'            signed out, no account with the email → create an account to join
 *   'signin'          signed out, an account already uses the email → sign in to join
 *   'accept'          signed in with the invited email → join
 *   'other_email'     signed in with another email → refused (copy in plan §B6)
 *   'member'          already an active member → link to the workspace
 *   'pending_company' the company is not confirmed yet → 409 page
 * Throws AppError 410 'invite_gone' for an unknown, expired, revoked, replaced or used token.
 * @typedef {object} InviteLanding
 * @property {{ id: string, name: string, status: OrgStatus }} org
 * @property {{ publicId: string, email: string, emailMasked: string, role: Role, roleLabel: string,
 *   departmentName: string|null, invitedByName: string, expiresAt: string }} invite
 * @property {'join'|'signin'|'accept'|'other_email'|'member'|'pending_company'} state
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
 * inventory.createBusinessInventory(config, { registry, overrides }). status 'none' (production today):
 * flights and hotels null, airports() and carriers() empty, cityFor() null.
 * @typedef {object} BusinessInventory
 * @property {InventoryStatus} status
 * @property {object|null} flights a FlightProvider (providers/contracts.js): BusinessDemoFlights in demo
 * @property {object|null} hotels a HotelProvider: BusinessDemoHotels in demo
 * @property {() => Array<{ code: string, name: string, city: string, country: string, tz: string }>} airports
 * @property {() => Array<{ code: string, name: string }>} carriers
 * @property {(iata: string) => { city: string, country: string }|null} cityFor DBB → New Alamein, CAI → Cairo
 */

/**
 * search.TripComposer (new TripComposer({ inventory, now })). Writes nothing, ever.
 * @typedef {object} TripComposer
 * @property {(raw: RawTripQuery, opts: { today: string }) => TripQuery} parseQuery search.parseTripQuery with
 *   this inventory's airports; 422 'invalid_query' with per-field details
 * @property {(query: TripQuery) => Promise<SearchResult>} search 503 'no_supplier' when status is 'none'
 * @property {(selection: Selection, query: TripQuery) => Promise<PriceResult>} price 422 'invalid_selection' for malformed keys
 * @property {(query: TripQuery, selection: Selection, opts: { datesFlexible: boolean, maxSearches?: number }) => Promise<VariantResult>} variants
 * @property {(request: Request) => Promise<RecheckResult>} recheck recheck.recheck(this, request)
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
 * @property {(rules: PolicyRules, opts: { tier: Tier, version: number, orgName: string, carriers: Record<string, string> }) => PolicyDescription} describe
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
