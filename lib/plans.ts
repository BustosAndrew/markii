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
  /**
   * Prices in USD minor units (`docs/PRICING.md` §3, marked **PROPOSED**).
   *
   * `annualPerMonthMinor` is the per-month figure when billed yearly, which is
   * how the table states it — not the yearly total. Annual is materially
   * cheaper for Markii too, not just a discount: Stripe's 30¢ fixed fee makes a
   * $19 monthly charge cost ~4.5% of revenue against ~3.8% annually (D2).
   */
  monthlyPriceMinor: number;
  annualPerMonthMinor: number;
};

const PLANS: Record<PlanId, PlanSpec> = {
  starter: {
    storeLimit: 1,
    staffSeatLimit: null,
    gmvThresholdMinor: 150_000_00,
    overageRateBps: 50,
    media: { storageGb: 10, monthlyEgressGb: 50 },
    monthlyPriceMinor: 19_00,
    annualPerMonthMinor: 15_00,
    includedAddOns: {},
  },
  growth: {
    storeLimit: 3,
    staffSeatLimit: null,
    gmvThresholdMinor: 750_000_00,
    overageRateBps: 40,
    media: { storageGb: 50, monthlyEgressGb: 250 },
    monthlyPriceMinor: 49_00,
    annualPerMonthMinor: 39_00,
    includedAddOns: {},
  },
  scale: {
    storeLimit: 10,
    staffSeatLimit: null,
    gmvThresholdMinor: 3_000_000_00,
    overageRateBps: 30,
    media: { storageGb: 250, monthlyEgressGb: 1024 },
    monthlyPriceMinor: 129_00,
    annualPerMonthMinor: 99_00,
    // Chargeback Assist is "included" at Scale, "available" below (PRICING §3).
    includedAddOns: { chargebackAssist: true },
  },
};

export type PlanCatalogEntry = {
  planId: PlanId;
  monthlyPriceMinor: number;
  annualPerMonthMinor: number;
  gmvThresholdMinor: number;
  overageRateBps: number;
  storeLimit: number;
  staffSeatLimit: number | null;
  media: Entitlements["media"];
  includedAddOns: Partial<Entitlements["addOns"]>;
};

/**
 * The public plan catalog (§17 `GET /api/billing/plans`).
 *
 * Prices are **PROPOSED** in `docs/PRICING.md` §3 and marked as such wherever
 * they surface — they have not been signed off, and shipping them as settled
 * would be a commitment nobody made.
 */
export function planCatalog(): PlanCatalogEntry[] {
  return (Object.keys(PLANS) as PlanId[]).map((planId) => {
    const p = PLANS[planId];
    return {
      planId,
      monthlyPriceMinor: p.monthlyPriceMinor,
      annualPerMonthMinor: p.annualPerMonthMinor,
      gmvThresholdMinor: p.gmvThresholdMinor,
      overageRateBps: p.overageRateBps,
      storeLimit: p.storeLimit,
      staffSeatLimit: p.staffSeatLimit,
      media: p.media,
      includedAddOns: p.includedAddOns,
    };
  });
}

export function planPricing(planId: PlanId): { monthlyPriceMinor: number; annualPerMonthMinor: number } {
  const p = PLANS[planId];
  return { monthlyPriceMinor: p.monthlyPriceMinor, annualPerMonthMinor: p.annualPerMonthMinor };
}

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
