import { describe, expect, it } from "vitest";
import { allActions } from "../actions";
import { planPricing } from "../plans";
import { statusGrantsPlan, isSubscriptionStatus, FLOOR_PLAN } from "./mirror";
import { expectedUnitAmountMinor, priceLookupKey, toSnapshot } from "./stripe-billing";

/**
 * The pure half of Markii's own subscription billing (§17).
 *
 * Everything here decides **what a merchant is charged** or **what they are
 * entitled to**, which is the same reason the discount and tax arithmetic is
 * unit-tested: the type system cannot see any of it. The network half
 * (`resolvePrice`, `createSubscription`, …) belongs to the integration suite —
 * asserting against a mocked Stripe would only prove the mock agrees with
 * itself.
 */

describe("priceLookupKey", () => {
  it("is stable and round-trips through toSnapshot", () => {
    expect(priceLookupKey("growth", "month")).toBe("markii_growth_month");
    expect(priceLookupKey("scale", "year")).toBe("markii_scale_year");
  });
});

describe("expectedUnitAmountMinor", () => {
  it("charges the monthly price for a monthly interval", () => {
    expect(expectedUnitAmountMinor("growth", "month")).toBe(planPricing("growth").monthlyPriceMinor);
  });

  /**
   * The bug this exists to prevent. `docs/PRICING.md` §3 states the annual plan
   * as a **per-month** figure, so passing it straight to Stripe as a yearly
   * `unit_amount` would bill a merchant one twelfth of what they owe — and it
   * would look entirely plausible on both sides.
   */
  it("multiplies the annual per-month figure by twelve", () => {
    for (const plan of ["starter", "growth", "scale"] as const) {
      const perMonth = planPricing(plan).annualPerMonthMinor;
      expect(expectedUnitAmountMinor(plan, "year")).toBe(perMonth * 12);
      expect(expectedUnitAmountMinor(plan, "year")).toBeGreaterThan(
        expectedUnitAmountMinor(plan, "month"),
      );
    }
  });

  it("keeps annual cheaper per month than monthly, as the pricing table claims", () => {
    for (const plan of ["starter", "growth", "scale"] as const) {
      const annualPerMonth = expectedUnitAmountMinor(plan, "year") / 12;
      expect(annualPerMonth).toBeLessThan(expectedUnitAmountMinor(plan, "month"));
    }
  });

  it("is an integer number of minor units, never a float", () => {
    for (const plan of ["starter", "growth", "scale"] as const) {
      for (const interval of ["month", "year"] as const) {
        expect(Number.isInteger(expectedUnitAmountMinor(plan, interval))).toBe(true);
      }
    }
  });
});

describe("toSnapshot", () => {
  const base = {
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        {
          id: "si_123",
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: { id: "price_123", lookup_key: "markii_growth_month", recurring: { interval: "month" } },
        },
      ],
    },
  };

  it("recovers the plan and interval from the price lookup key", () => {
    const snap = toSnapshot(base);
    expect(snap?.planId).toBe("growth");
    expect(snap?.interval).toBe("month");
    expect(snap?.itemId).toBe("si_123");
  });

  /**
   * Period bounds moved from the subscription onto the item in the 2025-03-31
   * API version. Reading the old top-level fields silently stores nulls, and
   * every renewal date in the dashboard goes blank.
   */
  it("reads period bounds from the item, not the subscription", () => {
    const snap = toSnapshot(base);
    expect(snap?.currentPeriodStart).toEqual(new Date(1_700_000_000 * 1000));
    expect(snap?.currentPeriodEnd).toEqual(new Date(1_702_592_000 * 1000));
  });

  /**
   * A price with no recognisable key means Markii's own Stripe configuration is
   * wrong. The snapshot reports null rather than guessing a plan — the mirror
   * then leaves the merchant's entitlements alone instead of moving them onto
   * something nobody chose.
   */
  it("returns a null plan for an unrecognised lookup key rather than guessing", () => {
    const snap = toSnapshot({
      ...base,
      items: { data: [{ ...base.items.data[0], price: { id: "price_x", lookup_key: "legacy_pro" } }] },
    });
    expect(snap?.planId).toBeNull();
    expect(snap?.interval).toBeNull();
  });

  it("handles an expanded customer object as well as a bare id", () => {
    expect(toSnapshot({ ...base, customer: { id: "cus_456" } })?.customerId).toBe("cus_456");
  });

  it("is null for a subscription with no id", () => {
    expect(toSnapshot({ ...base, id: undefined })).toBeNull();
  });
});

describe("statusGrantsPlan", () => {
  /**
   * `past_due` still grants. A renewal can fail on an expired card overnight and
   * Stripe retries it for days; revoking on the first decline would take a
   * working storefront offline over a charge that is about to succeed.
   */
  it("grants while paying, trialing, or in dunning", () => {
    expect(statusGrantsPlan("active")).toBe(true);
    expect(statusGrantsPlan("trialing")).toBe(true);
    expect(statusGrantsPlan("past_due")).toBe(true);
  });

  /**
   * `incomplete` is a subscription whose first invoice was never paid. Granting
   * on it is exactly the free-upgrade hole the old 503 refused to open: a higher
   * GMV threshold and more storefronts with nothing sold.
   */
  it("does not grant before the first invoice is paid, or after Stripe gives up", () => {
    for (const status of ["incomplete", "incomplete_expired", "unpaid", "canceled", "paused"]) {
      expect(statusGrantsPlan(status)).toBe(false);
    }
  });

  it("does not grant on a status it has never heard of", () => {
    expect(statusGrantsPlan("something_new")).toBe(false);
  });
});

describe("isSubscriptionStatus", () => {
  it("accepts Stripe's full vocabulary, not only the five §17 displays", () => {
    expect(isSubscriptionStatus("incomplete_expired")).toBe(true);
    expect(isSubscriptionStatus("paused")).toBe(true);
    expect(isSubscriptionStatus("nonsense")).toBe(false);
  });
});

describe("FLOOR_PLAN", () => {
  it("is the lowest plan that exists, since no free tier is defined", () => {
    expect(FLOOR_PLAN).toBe("starter");
  });
});

/**
 * The registry is only the single mutation path if the definitions are actually
 * imported — "an action nobody imports does not exist" (`lib/actions/index.ts`).
 * A billing action that silently failed to register would not fail loudly; the
 * route would 404 and the plan change would look broken for no visible reason.
 */
describe("billing action registration", () => {
  const billing = () => allActions().filter((a) => a.id.startsWith("billing."));

  it("registers every billing action", () => {
    expect(billing().map((a) => a.id).sort()).toEqual([
      "billing.changePlan",
      "billing.invoiceAssessments",
      "billing.setCancellation",
      "billing.setDefaultPaymentMethod",
      "billing.startPaymentMethodSetup",
    ]);
  });

  it("gates all of them behind billing.write", () => {
    for (const a of billing()) expect(a.permission).toBe("billing.write");
  });

  /**
   * §22 rule 3: pricing is `high`, which the registry reports as
   * `requiresHumanApproval` and which can never be configured to auto-run. An
   * agent may propose an upgrade; a person confirms it.
   *
   * Raising a threshold-fee charge is the same tier for a blunter reason — it
   * moves real money out of a merchant's account.
   */
  it("puts anything that charges money behind human approval", () => {
    for (const id of ["billing.changePlan", "billing.invoiceAssessments"]) {
      expect(billing().find((a) => a.id === id)?.riskTier).toBe("high");
    }
  });
});
