import type { Organization, PlanId } from "./db";

/**
 * Plan → entitlements. The numbers come from `docs/PRICING.md` §3 (D1, accepted
 * 2026-07-29) and this file is their **only** representation in code.
 *
 * Entitlements are derived rather than stored on the org row on purpose: a
 * denormalized copy drifts the moment pricing changes, and then two gates
 * disagree about what a merchant bought. `docs/PRICING.md` calls for "a single
 * typed `entitlements` object [driving] every gate" — this is it.
 */

export type Entitlements = {
  storeLimit: number;
  /** `null` = unlimited. Every plan has unlimited seats (D1) — this kills the per-seat add-on. */
  staffSeatLimit: number | null;
  /**
   * Annual threshold in **billing-currency minor units**, not dollars. USD has
   * two decimals, so $150k is 15_000_000 — but the exponent is the currency's,
   * never a hardcoded 100 (D31).
   */
  gmvThresholdMinor: number;
  /** Basis points on the slice **above** the threshold only. 50 = 0.50%. */
  overageRateBps: number;
  addOns: { agentOps: boolean; chargebackAssist: boolean };
  media: { storageGb: number; monthlyEgressGb: number };
};

type PlanSpec = Omit<Entitlements, "addOns"> & {
  /** Add-ons this plan includes outright, before anything the org has purchased. */
  includedAddOns: Partial<Entitlements["addOns"]>;
};

const PLANS: Record<PlanId, PlanSpec> = {
  starter: {
    storeLimit: 1,
    staffSeatLimit: null,
    gmvThresholdMinor: 150_000_00,
    overageRateBps: 50,
    media: { storageGb: 10, monthlyEgressGb: 50 },
    includedAddOns: {},
  },
  growth: {
    storeLimit: 3,
    staffSeatLimit: null,
    gmvThresholdMinor: 750_000_00,
    overageRateBps: 40,
    media: { storageGb: 50, monthlyEgressGb: 250 },
    includedAddOns: {},
  },
  scale: {
    storeLimit: 10,
    staffSeatLimit: null,
    gmvThresholdMinor: 3_000_000_00,
    overageRateBps: 30,
    media: { storageGb: 250, monthlyEgressGb: 1024 },
    // Chargeback Assist is "included" at Scale, "available" below (PRICING §3).
    includedAddOns: { chargebackAssist: true },
  },
};

/**
 * Resolve what an org may actually do: plan baseline, plus purchased add-ons and
 * extra storefronts.
 */
export function entitlementsFor(
  org: Pick<
    Organization,
    "planId" | "addOnAgentOps" | "addOnChargebackAssist" | "extraStorefronts"
  >,
): Entitlements {
  const plan = PLANS[org.planId];
  return {
    storeLimit: plan.storeLimit + org.extraStorefronts,
    staffSeatLimit: plan.staffSeatLimit,
    gmvThresholdMinor: plan.gmvThresholdMinor,
    overageRateBps: plan.overageRateBps,
    media: plan.media,
    addOns: {
      agentOps: plan.includedAddOns.agentOps ?? org.addOnAgentOps,
      chargebackAssist: plan.includedAddOns.chargebackAssist ?? org.addOnChargebackAssist,
    },
  };
}
