import type { ActionOutcome } from "./actions";
import type { AccountStanding, PlanId } from "./billing";
import { apiDelete, apiGet, apiPost, buildQuery } from "./client";

/**
 * Platform operations (G12) — `/api/admin/*`. ✅ LIVE 2026-09-15.
 *
 * **Operator-only, and that is decided server-side.** The caller is the
 * signed-in staff user; `requireOperator` checks their address against
 * `PLATFORM_OPERATOR_EMAILS`. A merchant calling these gets `403 FORBIDDEN`,
 * and on a deployment with no allowlist everyone gets
 * `503 CONFIGURATION_REQUIRED`. `MeResponse.operator` says whether to show
 * the way in; it grants nothing.
 *
 * The screens live under `/admin` (`app/(admin)/`) — **not** under the
 * merchant dashboard and never linked from merchant navigation except for the
 * operator-only link the sidebar shows when `me.operator` is true. It is not a
 * merchant feature.
 *
 * Suspension is the registry's `platform.suspendOrg` / `platform.unsuspendOrg`,
 * so both return an `ActionOutcome`, support `dryRun`, demand a fresh factor
 * (the `MfaStepUpProvider` modal fires as for any other step-up), and appear
 * in the merchant's audit log as "Markii operator".
 */
export const ADMIN_API_LIVE = true;

export type PlatformOrgView = {
  id: string;
  slug: string;
  name: string;
  billingEmail: string;
  /** ISO. */
  createdAt: string;
  planId: PlanId;
  /** What the merchant themselves would see — the operator's reason is in `suspension`, not here. */
  standing: AccountStanding;
  suspension: {
    /** ISO. */
    since: string;
    /** The operator's note — also in the merchant's audit log, so written for them. */
    reason: string | null;
    /** The operator's user id. */
    by: string | null;
  } | null;
  stores: { id: number; slug: string; name: string; status: "draft" | "live" | "paused" }[];
  /** `userId` is null for an invitation not yet accepted. `mfaEnrolled` counts verified factors only. */
  staff: {
    userId: string | null;
    email: string;
    role: string;
    status: "active" | "invited" | "disabled";
    mfaEnrolled: boolean;
  }[];
};

export type PlatformOrgListItem = {
  id: string;
  slug: string;
  name: string;
  billingEmail: string;
  createdAt: string;
  planId: PlanId;
  standing: AccountStanding;
  suspendedAt: string | null;
  storeCount: number;
};

export type PlatformOrgListQuery = {
  q?: string;
  suspended?: boolean;
  page?: number;
  limit?: number;
};

export type PlatformOrgList = {
  items: PlatformOrgListItem[];
  total: number;
  page: number;
  limit: number;
};

export type PlatformSignups = {
  since: string;
  until: string;
  days: number;
  threshold: number;
  total: number;
  /** Domains at or over `threshold`, largest first. The platform's own domain is never here. */
  bursts: {
    domain: string;
    count: number;
    orgs: { slug: string; name: string; email: string; createdAt: string }[];
  }[];
  recent: {
    id: string;
    slug: string;
    name: string;
    billingEmail: string;
    createdAt: string;
    suspended: boolean;
  }[];
};

export type PlatformOverview = {
  orgs: number;
  suspended: number;
  signups24h: number;
  flaggedDomains: number;
  threshold: number;
  recentSuspensions: {
    id: string;
    slug: string;
    name: string;
    suspendedAt: string;
    suspendedReason: string | null;
  }[];
};

/** `idOrSlug`: the digest names slugs, the audit log names ids; both work. */
export function getPlatformOrg(idOrSlug: string) {
  return apiGet<PlatformOrgView>(`/api/admin/orgs/${encodeURIComponent(idOrSlug)}`);
}

export function listPlatformOrgs(query: PlatformOrgListQuery = {}) {
  return apiGet<PlatformOrgList>(`/api/admin/orgs${buildQuery(query)}`);
}

export function getPlatformSignups(days = 1) {
  return apiGet<PlatformSignups>(`/api/admin/signups${buildQuery({ days })}`);
}

export function getPlatformOverview() {
  return apiGet<PlatformOverview>("/api/admin/overview");
}

export type SuspendResult = { orgId: string; slug: string; suspendedAt: string; note: string };
export type UnsuspendResult = {
  orgId: string;
  slug: string;
  wasSuspendedSince: string;
  note: string;
};

/**
 * `reason` is required (3–1000 chars) and lands in the merchant's own audit
 * log as the input of `platform.suspendOrg` — write it as the thing you would
 * say to them, because you are.
 */
export function suspendPlatformOrg(idOrSlug: string, reason: string, opts?: { dryRun?: boolean }) {
  const q = opts?.dryRun ? "?dryRun=1" : "";
  return apiPost<ActionOutcome<SuspendResult>>(
    `/api/admin/orgs/${encodeURIComponent(idOrSlug)}/suspend${q}`,
    { reason },
  );
}

export type ResetMfaResult = {
  userId: string;
  email: string;
  factorsRemoved?: number;
  factorsToRemove?: number;
  sessionsEnded?: number;
  /** The account email the notice was queued to — may differ from the staff row's. Not proof of delivery. */
  noticeTo?: string;
  note: string;
};

/**
 * `verification` (10–1000 chars) says how the account holder's identity was
 * confirmed. It is recorded in that org's audit log — the evidence behind the
 * one action here that an impersonator would want support to take.
 */
export function resetPlatformMfa(
  idOrSlug: string,
  userId: string,
  verification: string,
  opts?: { dryRun?: boolean },
) {
  const q = opts?.dryRun ? "?dryRun=1" : "";
  return apiPost<ActionOutcome<ResetMfaResult>>(
    `/api/admin/orgs/${encodeURIComponent(idOrSlug)}/staff/${encodeURIComponent(userId)}/reset-mfa${q}`,
    { verification },
  );
}

export function unsuspendPlatformOrg(idOrSlug: string, opts?: { dryRun?: boolean }) {
  const q = opts?.dryRun ? "?dryRun=1" : "";
  return apiDelete<ActionOutcome<UnsuspendResult>>(
    `/api/admin/orgs/${encodeURIComponent(idOrSlug)}/suspend${q}`,
  );
}
