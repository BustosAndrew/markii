import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import { callWhenLive } from "./planned";

const ORG_SECTION = "API §16";

/**
 * §16 is landing in pieces. `GET /api/me`, the org profile, and staff
 * management are live. Audit, sessions, and scoped tokens are not built yet, so
 * they keep failing loudly rather than returning a shape nobody wrote.
 */
const ME_API_LIVE = true;
const ORG_API_LIVE = true;
const STAFF_API_LIVE = true;
const ORG_AUDIT_API_LIVE = false;
const ORG_SESSIONS_API_LIVE = false;
const ORG_TOKENS_API_LIVE = false;

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

export type MeResponse = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
  org: Organization;
  role: StaffRole;
  entitlements: Organization["entitlements"];
};

export type OrgAuditEntry = {
  id: string;
  actor: { id: string; name: string; type: "user" | "agent" | "token" };
  action: string;
  entity: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  occurredAt: string;
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
  createdAt: string;
  lastUsedAt: string | null;
};

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

export function listOrgAudit(init?: RequestInit) {
  return callWhenLive(ORG_AUDIT_API_LIVE, ORG_SECTION, () =>
    apiGet<{ items: OrgAuditEntry[] }>("/api/org/audit", undefined, init),
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
  body: { label: string; role: StaffRole },
  init?: RequestInit,
) {
  return callWhenLive(ORG_TOKENS_API_LIVE, ORG_SECTION, () =>
    apiPost<ScopedToken>("/api/org/tokens", body, init),
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
