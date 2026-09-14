import { describe, expect, it } from "vitest";
import { addressLocatable, describePlatformTax, platformTaxApplication } from "./platform-tax";

/**
 * Whether Stripe Tax applies to Markii's own invoice (G3) — the decision, not
 * the Stripe calls. The real create/preview against Stripe is
 * `tests/integration/stripe-platform-tax.test.ts` (opt-in).
 */

const address = {
  line1: "1 Main St",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};
const active = { status: "active", headOffice: true };

describe("platformTaxApplication", () => {
  it("applies only when Tax is active on the platform and an address is on file", () => {
    expect(platformTaxApplication({ billingConfigured: true, settings: active, address })).toEqual({
      applies: true,
      reason: "active",
    });
  });

  /**
   * The two "no" reasons name different people. `tax_not_active` is Markii's
   * dashboard switch; `no_billing_address` is the merchant's form. A screen
   * rendering one boolean would send the wrong person to fix it.
   */
  it("names whose problem it is when it does not apply", () => {
    expect(
      platformTaxApplication({ billingConfigured: true, settings: active, address: null }).reason,
    ).toBe("no_billing_address");
    expect(
      platformTaxApplication({
        billingConfigured: true,
        settings: { status: "pending", headOffice: false },
        address,
      }).reason,
    ).toBe("tax_not_active");
    expect(
      platformTaxApplication({ billingConfigured: false, settings: active, address }).reason,
    ).toBe("billing_not_configured");
  });

  it("treats an unreadable settings response as not active, never as active", () => {
    expect(platformTaxApplication({ billingConfigured: true, settings: null, address }).applies).toBe(
      false,
    );
  });

  it("checks the platform before the address, so a missing address is not blamed for a missing activation", () => {
    const r = platformTaxApplication({
      billingConfigured: true,
      settings: { status: "pending", headOffice: false },
      address: null,
    });
    expect(r.reason).toBe("tax_not_active");
  });
});

describe("addressLocatable", () => {
  it("needs a country and a postal code — the two things Stripe places a customer by", () => {
    expect(addressLocatable(address)).toBe(true);
    expect(addressLocatable({ ...address, postalCode: " " })).toBe(false);
    expect(addressLocatable({ ...address, country: "USA" })).toBe(false);
    expect(addressLocatable(null)).toBe(false);
  });
});

describe("describePlatformTax", () => {
  it("has one sentence per state and never an empty one", () => {
    for (const reason of ["active", "no_billing_address", "tax_not_active", "billing_not_configured"] as const) {
      const application =
        reason === "active" ? { applies: true as const, reason } : { applies: false as const, reason };
      expect(describePlatformTax(application).length).toBeGreaterThan(20);
    }
  });
});
