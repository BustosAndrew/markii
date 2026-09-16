import type { ActionOutcome } from "./actions";
import type { AccountStanding } from "./billing";
import { apiDelete, apiGet, apiPost } from "./client";
import type { PlanId } from "./billing";

/**
 * Platform operations (G12) — `/api/admin/*`. ✅ LIVE 2026-09-15.
 *
 * **Operator-only, and that is decided server-side.** The caller is the
 * signed-in staff user; `requireOperator` checks their address against
 * `PLATFORM_OPERATOR_EMAILS`. A merchant calling these gets `403 FORBIDDEN`,
 * and on a deployment with no allowlist everyone gets
 * `503 CONFIGURATION_REQUIRED`. There is **no screen for this yet** and none
 * is on the frontend build order — it exists so the sign-up review digest has
 * an action behind it that is not "open a SQL client". If a screen is built,
 * it must not be reachable from the merchant navigation; it is not a merchant
 * feature.
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
};

/** `idOrSlug`: the digest names slugs, the audit log names ids; both work. */
export function getPlatformOrg(idOrSlug: string) {
  return apiGet<PlatformOrgView>(`/api/admin/orgs/${encodeURIComponent(idOrSlug)}`);
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

export function unsuspendPlatformOrg(idOrSlug: string, opts?: { dryRun?: boolean }) {
  const q = opts?.dryRun ? "?dryRun=1" : "";
  return apiDelete<ActionOutcome<UnsuspendResult>>(
    `/api/admin/orgs/${encodeURIComponent(idOrSlug)}/suspend${q}`,
  );
}
