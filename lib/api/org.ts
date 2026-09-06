import type { AccountStanding } from "./billing";
import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import { callWhenLive } from "./planned";

const ORG_SECTION = "API §16";

/**
 * §16 is landing in pieces. `GET /api/me`, the org profile, staff management,
 * scoped tokens, org switching **and MFA** are live — MFA shipped with D40
 * (`/api/auth/mfa/{enroll,challenge,recover}`), and this comment went on calling
 * it unbuilt for weeks afterwards. That is the one-directional staleness
 * `CLAUDE.md` warns about: work lands and the note does not move, so a "not
 * built" claim here is worth checking before it is believed.
 *
 * **The audit log is live as of 2026-09-06** — `GET /api/org/audit`, a read over
 * the same `action_invocations` rows `/api/actions/invocations` serves. It
 * waited on there being anything to audit, which the Phase C actions settled.
 *
 * **Sessions are genuinely absent** — verified 2026-09-06, no route backs
 * either half — so those keep failing loudly rather than returning a shape
 * nobody wrote.
 */
const ME_API_LIVE = true;
const ORG_API_LIVE = true;
const STAFF_API_LIVE = true;
const ORG_AUDIT_API_LIVE = true;
const ORG_SESSIONS_API_LIVE = false;
const ORG_TOKENS_API_LIVE = true;

export type StaffRole =
  | "owner"
  | "administrator"
  | "catalog_manager"
  | "commerce_manager"
  | "analyst"
  | "developer"
  | "viewer";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  billingEmail: string;
  currency: string;
  country: string;
  planId: string;
  entitlements: {
    storeLimit: number;
    staffSeatLimit: number | null;
    gmvThresholdMinor: number;
    overageRateBps: number;
    addOns: { agentOps: boolean; chargebackAssist: boolean };
  };
  createdAt: string;
};

export type StaffMember = {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  email: string;
  role: StaffRole;
  storeIds: number[] | "all";
  status: "active" | "invited" | "disabled";
  lastActiveAt: string | null;
};

export type OrgMembership = {
  id: string;
  name: string;
  slug: string;
  role: StaffRole;
  active: boolean;
};

export type MeResponse = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
  org: Organization;
  role: StaffRole;
  /** Every org this user belongs to — render the switcher from this, no second call. */
  organizations: OrgMembership[];
  entitlements: Organization["entitlements"];
  /**
   * Whether the account may transact at all — carried here, rather than only on
   * `GET /api/billing/subscription`, so the dashboard shell can render the trial
   * banner on every page without a second round trip and without the live Stripe
   * card lookup that endpoint performs.
   *
   * `ungated` means no trial date was recorded (pre-0035 rows) and is good
   * standing; do not render it as a warning.
   */
  standing: AccountStanding;
};

export type AuditActorType = "user" | "agent" | "token" | "system";
export type AuditRiskTier = "read" | "low" | "medium" | "high";

/** What an action changed, one field at a time, as the action itself recorded it. */
export type AuditChange = {
  entity: string;
  entityId: string;
  path: string;
  before: unknown;
  after: unknown;
};

/**
 * One audited invocation.
 *
 * **This shape was wrong while it was planned**, in the way `CLAUDE.md` warns a
 * stale type is worse than a missing one. It declared a flat
 * `entity`/`before`/`after`, which cannot describe what the log actually holds:
 * a single invocation records a field-level diff that may touch several fields
 * across several entities, so a flat triple would have forced the screen to
 * throw away everything but the first. It also promised `actor.name: string`
 * for an actor whose staff row may since have been deleted.
 */
export type OrgAuditEntry = {
  id: string;
  actor: {
    type: AuditActorType;
    id: string | null;
    /** Null when the staff row or token is gone — render the id, never a guess. */
    name: string | null;
    email: string | null;
  };
  action: string;
  riskTier: AuditRiskTier;
  /** False for a refused attempt. Those are audited too, and are the incident view. */
  ok: boolean;
  error: { code: string | null; message: string | null } | null;
  /** Distinct entities touched, first-seen order. Empty for an action with no diff. */
  entities: { type: string; id: string }[];
  changes: AuditChange[];
  /**
   * **Null is common and correct**, not a loading state: only HTTP callers have
   * an address, so the scheduled sweep and anything invoked from a shell record
   * none. It is a lead during an incident, never proof of identity.
   */
  ip: string | null;
  userAgent: string | null;
  undoable: boolean;
  /** Set when this change was later reversed — `POST /api/actions/:id/undo` (§22). */
  undoneBy: string | null;
  /** Set when this entry *is* the reversal of another. */
  undoOf: string | null;
  occurredAt: string;
};

export type OrgAuditFilters = {
  actorType?: AuditActorType;
  actorId?: string;
  actionId?: string;
  riskTier?: AuditRiskTier;
  ok?: boolean;
  /** ISO date or datetime; a date-only `to` covers the whole day. */
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};

export type SessionRecord = {
  id: string;
  userAgent: string;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
};

export type ScopedToken = {
  id: string;
  label: string;
  role: StaffRole;
  /** Leading characters, for telling tokens apart in a list. Not a secret. */
  prefix: string;
  storeIds: number[] | "all";
  createdAt: string;
  lastUsedAt: string | null;
};

/**
 * `POST /api/org/tokens` only. `token` is the plaintext and is returned **once** —
 * the server stores only a SHA-256, so it cannot be fetched again. Show it, let
 * the user copy it, and never persist it client-side.
 */
export type CreatedToken = ScopedToken & { token: string; tokenNote: string };

export function getMe(init?: RequestInit) {
  return callWhenLive(ME_API_LIVE, ORG_SECTION, () =>
    apiGet<MeResponse>("/api/me", undefined, init),
  );
}

export function getOrg(init?: RequestInit) {
  return callWhenLive(ORG_API_LIVE, ORG_SECTION, () =>
    apiGet<Organization>("/api/org", undefined, init),
  );
}

export function updateOrg(
  body: Partial<Pick<Organization, "name" | "billingEmail" | "currency" | "country">>,
  init?: RequestInit,
) {
  return callWhenLive(ORG_API_LIVE, ORG_SECTION, () =>
    apiPatch<Organization>("/api/org", body, init),
  );
}

/**
 * Change the active organization. Membership is re-checked server-side, so a
 * `403` here means the user genuinely is not a member — not a stale cookie.
 * Refetch `getMe()` afterwards; every subsequent request is scoped to the new org.
 */
export function switchOrg(body: { orgId: string }, init?: RequestInit) {
  return callWhenLive(ORG_API_LIVE, ORG_SECTION, () =>
    apiPost<{ orgId: string; name: string; slug: string }>("/api/org/switch", body, init),
  );
}

export function listStaff(init?: RequestInit) {
  return callWhenLive(STAFF_API_LIVE, ORG_SECTION, () =>
    apiGet<{ items: StaffMember[] }>("/api/org/staff", undefined, init),
  );
}

export function inviteStaff(
  body: { email: string; role: StaffRole; storeIds: number[] | "all" },
  init?: RequestInit,
) {
  return callWhenLive(STAFF_API_LIVE, ORG_SECTION, () =>
    apiPost<StaffMember>("/api/org/staff/invite", body, init),
  );
}

export function updateStaff(
  id: string,
  body: Partial<Pick<StaffMember, "role" | "storeIds" | "status">>,
  init?: RequestInit,
) {
  return callWhenLive(STAFF_API_LIVE, ORG_SECTION, () =>
    apiPatch<StaffMember>(`/api/org/staff/${encodeURIComponent(id)}`, body, init),
  );
}

export function deleteStaff(id: string, init?: RequestInit) {
  return callWhenLive(STAFF_API_LIVE, ORG_SECTION, () =>
    apiDelete<{ deleted: boolean; id: string }>(
      `/api/org/staff/${encodeURIComponent(id)}`,
      init,
    ),
  );
}

/**
 * The org's change history, newest first.
 *
 * Requires `org.audit`, which only `owner` and `administrator` hold — a `403`
 * here is a role answer, not a bug. Reading everyone's activity, with the input
 * each action was called with, is deliberately not part of a `viewer` seat.
 */
export function listOrgAudit(filters: OrgAuditFilters = {}, init?: RequestInit) {
  return callWhenLive(ORG_AUDIT_API_LIVE, ORG_SECTION, () =>
    apiGet<{ items: OrgAuditEntry[]; total: number; page: number; limit: number }>(
      "/api/org/audit",
      // Every field is a QueryValue, and buildQuery drops the undefined ones.
      filters,
      init,
    ),
  );
}

export function listSessions(init?: RequestInit) {
  return callWhenLive(ORG_SESSIONS_API_LIVE, ORG_SECTION, () =>
    apiGet<{ items: SessionRecord[] }>("/api/org/sessions", undefined, init),
  );
}

export function revokeSession(id: string, init?: RequestInit) {
  return callWhenLive(ORG_SESSIONS_API_LIVE, ORG_SECTION, () =>
    apiDelete<{ deleted: boolean; id: string }>(
      `/api/org/sessions/${encodeURIComponent(id)}`,
      init,
    ),
  );
}

export function listTokens(init?: RequestInit) {
  return callWhenLive(ORG_TOKENS_API_LIVE, ORG_SECTION, () =>
    apiGet<{ items: ScopedToken[] }>("/api/org/tokens", undefined, init),
  );
}

export function createToken(
  body: { label: string; role: StaffRole; storeIds?: number[] | "all" },
  init?: RequestInit,
) {
  return callWhenLive(ORG_TOKENS_API_LIVE, ORG_SECTION, () =>
    apiPost<CreatedToken>("/api/org/tokens", body, init),
  );
}

export function deleteToken(id: string, init?: RequestInit) {
  return callWhenLive(ORG_TOKENS_API_LIVE, ORG_SECTION, () =>
    apiDelete<{ deleted: boolean; id: string }>(
      `/api/org/tokens/${encodeURIComponent(id)}`,
      init,
    ),
  );
}
