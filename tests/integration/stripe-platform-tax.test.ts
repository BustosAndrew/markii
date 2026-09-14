import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";

/**
 * Stripe Tax on **Markii's own** subscription, against real Stripe (G3).
 *
 * The decision logic is unit-tested and the reporting is covered by
 * `billing-address.test.ts`; what neither can show is that the subscription
 * Stripe actually creates carries `automatic_tax.enabled`, that its first
 * invoice resolved a location, and that an existing untaxed subscription is
 * brought under Tax when the address arrives later. All three are the
 * boundary, and the boundary is the thing that has been wrong before.
 *
 * **Opt-in, like `stripe-fee-invoice.test.ts`, and for the same reasons** — it
 * creates objects in a Stripe account, and it refuses a live key:
 *
 *   MARKII_STRIPE_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *     vitest run --project integration stripe-platform-tax
 *
 * It also requires Stripe Tax to be **active** on the platform test account
 * (`GET /v1/tax/settings` → `active`), which is a dashboard switch; it skips
 * with a message rather than failing when it is not.
 */

const ENABLED = process.env.MARKII_STRIPE_TESTS === "1";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const IS_TEST_KEY = KEY.startsWith("sk_test") || KEY.startsWith("rk_test");
const STRIPE = "https://api.stripe.com/v1";

async function stripe<T = any>(
  path: string,
  init?: { method?: string; form?: Record<string, string> },
): Promise<T> {
  const res = await fetch(`${STRIPE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${KEY}`,
      "Stripe-Version": "2026-07-29.dahlia",
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} → ${res.status}: ${json?.error?.message ?? "unknown"}`);
  return json as T;
}

describe.skipIf(!ENABLED || !IS_TEST_KEY)("platform Stripe Tax → real subscription", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let taxActive = false;
  const created: { customers: string[]; subscriptions: string[] } = { customers: [], subscriptions: [] };

  const address = { line1: "430 Sutter St", city: "Manteca", state: "CA", postalCode: "95336", country: "US" };

  beforeAll(async () => {
    taxActive = (await stripe("/tax/settings")).status === "active";
    const { email } = await signUpMerchant(merchant, "platform-tax");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of created.subscriptions) {
      await stripe(`/subscriptions/${id}`, { method: "DELETE" }).catch(() => {});
    }
    for (const id of created.customers) {
      await stripe(`/customers/${id}`, { method: "DELETE" }).catch(() => {});
    }
    await cleanup.run();
  }, 60_000);

  async function stripeStateFor(org: string) {
    const [row] = await sql`select stripe_customer_id, stripe_subscription_id from organizations where id = ${org}`;
    if (row.stripe_customer_id) created.customers.push(row.stripe_customer_id);
    if (row.stripe_subscription_id) created.subscriptions.push(row.stripe_subscription_id);
    return row;
  }

  it("creates the first subscription untaxed when no address is on file, and says so", async () => {
    const res = await merchant.post("/api/billing/subscription", { planId: "growth", confirm: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.confirmed).toBe(true);
    expect(res.json.result.tax.applied).toBe(false);
    expect(res.json.result.tax.reason).toBe(taxActive ? "no_billing_address" : "tax_not_active");

    const row = await stripeStateFor(orgId);
    const sub = await stripe(`/subscriptions/${row.stripe_subscription_id}`);
    expect(sub.automatic_tax.enabled).toBe(false);
  });

  it("brings that subscription under Tax when the address arrives", async ({ skip }) => {
    if (!taxActive) skip("Stripe Tax is not active on the platform test account");

    /**
     * The subscription is `incomplete` (nothing paid it) and grants no plan,
     * so the action would not touch it — seed the mirror to `active` the way
     * the webhook would after a payment, which is the state the repair path
     * exists for.
     */
    await sql`update organizations set subscription_status = 'active' where id = ${orgId}`;

    const res = await merchant.post("/api/actions/billing.updateBillingAddress", { address });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.tax.applied).toBe(true);

    const row = await stripeStateFor(orgId);
    const customer = await stripe(`/customers/${row.stripe_customer_id}`);
    expect(customer.address.postal_code).toBe("95336");
    const sub = await stripe(`/subscriptions/${row.stripe_subscription_id}`);
    expect(sub.automatic_tax.enabled).toBe(true);
  });

  it("creates a taxed subscription for a merchant whose address was on file first", async ({ skip }) => {
    if (!taxActive) skip("Stripe Tax is not active on the platform test account");

    const second = new Client();
    const { email } = await signUpMerchant(second, "platform-tax-2");
    cleanup.merchantEmails.push(email);
    const secondOrg = (await second.get("/api/me")).json.org.id;

    const saved = await second.post("/api/actions/billing.updateBillingAddress", { address });
    expect(saved.status).toBe(200);

    // The preview and the create must agree: both taxed, both from Stripe.
    const preview = await second.post("/api/billing/subscription", { planId: "growth" });
    expect(preview.json.result.preview.taxStatus).toBe("complete");
    const previewTax = preview.json.result.preview.taxMinor;

    const res = await second.post("/api/billing/subscription", { planId: "growth", confirm: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.tax.applied).toBe(true);

    const row = await stripeStateFor(secondOrg);
    const sub = await stripe(`/subscriptions/${row.stripe_subscription_id}?expand[]=latest_invoice`);
    expect(sub.automatic_tax.enabled).toBe(true);
    /** `complete` means a location resolved and rates were applied — even if the rate was 0. */
    expect(sub.latest_invoice.automatic_tax.status).toBe("complete");
    const invoiceTax = (sub.latest_invoice.total_taxes ?? []).reduce(
      (sum: number, t: { amount: number }) => sum + t.amount,
      0,
    );
    expect(invoiceTax).toBe(previewTax);
  });
});
