import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";

/**
 * The merchant's billing address and Stripe Tax on Markii's own subscription
 * (G3, `docs/API.md` §17).
 *
 * What is under test is the wiring, not Stripe's arithmetic: that the reason a
 * merchant is or is not taxed is *reported* and names the right party, that the
 * address is refused when Stripe could not place it, that a preview for a
 * merchant with an address carries the tax line Stripe computed, and that undo
 * is bounded to a previous address rather than faking "none".
 *
 * **Reads Stripe, creates nothing.** `GET /v1/tax/settings` and
 * `POST /invoices/create_preview` leave no object behind; the file that creates
 * a real taxed subscription is `stripe-platform-tax.test.ts`, opt-in.
 */
describe("billing address and platform tax", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  /** What Stripe says about the platform account, read directly so the assertions can be exact. */
  let platformTaxActive = false;

  const address = {
    line1: "1 Main St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "us",
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "billing-address");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const key = process.env.STRIPE_SECRET_KEY ?? "";
    if (key) {
      const res = await fetch("https://api.stripe.com/v1/tax/settings", {
        headers: { authorization: `Bearer ${key}`, "Stripe-Version": "2026-07-29.dahlia" },
      });
      platformTaxActive = res.ok && (await res.json()).status === "active";
    }
  });

  afterAll(async () => {
    await cleanup.run();
  });

  it("reports no address and names the merchant as the reason, not Markii", async () => {
    const res = await merchant.get("/api/billing/subscription");
    expect(res.status).toBe(200);
    expect(res.json.billingAddress).toBeNull();
    expect(res.json.tax.applied).toBe(false);
    // With Tax active on the platform the only thing missing is the merchant's
    // address; without it, that is the reason and the address is not blamed.
    expect(res.json.tax.reason).toBe(platformTaxActive ? "no_billing_address" : "tax_not_active");
    expect(typeof res.json.tax.message).toBe("string");
  });

  it("refuses a US address with no state — Stripe cannot place it", async () => {
    const res = await merchant.post("/api/actions/billing.updateBillingAddress", {
      address: { ...address, state: undefined },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_ERROR");
  });

  it("saves the address, uppercases the country, and reports tax as applied when the platform can", async () => {
    const res = await merchant.post("/api/actions/billing.updateBillingAddress", { address });
    expect(res.status).toBe(200);
    expect(res.json.result.address).toMatchObject({ line1: "1 Main St", country: "US", state: "TX" });
    expect(res.json.result.tax.applied).toBe(platformTaxActive);
    expect(res.json.result.tax.reason).toBe(platformTaxActive ? "active" : "tax_not_active");

    const [row] = await sql`select billing_address from organizations where id = ${orgId}`;
    expect(row.billing_address.country).toBe("US");

    const org = await merchant.get("/api/org");
    expect(org.json.billingAddress.postalCode).toBe("78701");
    const sub = await merchant.get("/api/billing/subscription");
    expect(sub.json.billingAddress.city).toBe("Austin");
    expect(sub.json.tax.applied).toBe(platformTaxActive);
  });

  it("previews a first subscription with Stripe's tax line when tax applies", async () => {
    const res = await merchant.post("/api/billing/subscription", { planId: "growth" });
    expect(res.status).toBe(200);
    const { result } = res.json;
    expect(result.confirmed).toBe(false);
    expect(result.preview.kind).toBe("first_subscription");
    expect(result.tax.applied).toBe(platformTaxActive);

    if (platformTaxActive) {
      /**
       * Previewed by Stripe against the address, so the amount is what will be
       * charged — tax included and stated on its own — rather than the bare
       * price a local preview would show.
       */
      expect(typeof result.preview.taxMinor).toBe("number");
      expect(result.preview.taxStatus).toBe("complete");
      expect(result.preview.amountDueMinor).toBeGreaterThanOrEqual(4900 + result.preview.taxMinor);
    } else {
      expect(result.preview.taxMinor).toBeUndefined();
      expect(result.preview.amountDueMinor).toBe(4900);
    }

    // A preview leaves nothing behind — no customer, no subscription.
    const [row] = await sql`select stripe_customer_id, stripe_subscription_id from organizations where id = ${orgId}`;
    expect(row.stripe_customer_id).toBeNull();
    expect(row.stripe_subscription_id).toBeNull();
  });

  it("undoes back to the previous address, and refuses to undo back to none", async () => {
    const first = await merchant.get("/api/actions/invocations?actionId=billing.updateBillingAddress&limit=5");
    expect(first.status).toBe(200);
    const original = first.json.items?.[0] ?? first.json.invocations?.[0] ?? first.json[0];
    expect(original).toBeTruthy();

    const second = await merchant.post("/api/actions/billing.updateBillingAddress", {
      address: { ...address, line1: "2 Second Ave", postalCode: "78702" },
    });
    expect(second.status).toBe(200);

    const undone = await merchant.post("/api/actions/billing.updateBillingAddress/undo", {
      invocationId: second.json.invocationId,
    });
    expect(undone.status).toBe(200);
    const [row] = await sql`select billing_address from organizations where id = ${orgId}`;
    expect(row.billing_address.line1).toBe("1 Main St");

    // The very first set had no address before it; there is nothing honest to restore.
    const refused = await merchant.post("/api/actions/billing.updateBillingAddress/undo", {
      invocationId: original.invocationId ?? original.id,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });
});
