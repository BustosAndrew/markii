import type { PlanId } from "../db";
import { planPricing } from "../plans";

/**
 * What Markii's Stripe Prices must look like, derived from `lib/plans.ts`.
 *
 * **Deliberately not `server-only`.** Two things need this derivation and they
 * come at it from opposite directions: `resolvePrice` *verifies* a Price at
 * runtime and refuses when Stripe disagrees, and `scripts/stripe-prices.ts`
 * *creates* the Prices in the first place. If the creator and the verifier each
 * carried their own copy, a provisioning script could confidently create exactly
 * the price the app then refuses — so the derivation lives here, once, and both
 * import it. `server-only` on the transport module is what forced the split;
 * keeping it is what keeps them honest.
 *
 * `lib/plans.ts` stays the only source of the numbers themselves.
 */

export type BillingInterval = "month" | "year";

/**
 * The stable identifier for a plan's Price on Markii's own Stripe account.
 *
 * Prices are looked up by key rather than by id, so there is no
 * `STRIPE_PRICE_*` variable and a Price can be rotated in Stripe without a
 * redeploy — archive the old one, create the replacement with the same key.
 */
export function priceLookupKey(planId: PlanId, interval: BillingInterval): string {
  return `markii_${planId}_${interval}`;
}

/**
 * What the Stripe Price *should* charge.
 *
 * **`annualPerMonthMinor` is not the amount Stripe charges.** `docs/PRICING.md`
 * §3 quotes annual plans per month because that is how merchants compare them,
 * but a yearly Price bills twelve of those at once. Anything that reads the plan
 * table and hands the number straight to Stripe undercharges by a factor of
 * twelve — and it looks correct in the Stripe dashboard, because $15 is a real
 * number from a real column. This multiplication is the only thing standing
 * between that mistake and a year of underbilling.
 */
export function expectedUnitAmountMinor(planId: PlanId, interval: BillingInterval): number {
  const p = planPricing(planId);
  return interval === "year" ? p.annualPerMonthMinor * 12 : p.monthlyPriceMinor;
}

/** Stripe Product id per plan. Set explicitly so provisioning is idempotent. */
export function productIdFor(planId: PlanId): string {
  return `markii_${planId}`;
}
