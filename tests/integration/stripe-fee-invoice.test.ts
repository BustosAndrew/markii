import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * The threshold fee reaching a **real Stripe invoice** (§17, §25).
 *
 * This is the last money path in the codebase that had never actually run.
 * `createFeeInvoiceItem` is unit-tested and idempotent, and the sweep is
 * integration-tested — but every org in those tests lacks a subscription, so
 * `assessmentBillable` refuses before Stripe is ever called. Everything up to
 * the API boundary was proven; the boundary itself was not.
 *
 * **Opt-in, and separately from the rest of the suite.** No other test here
 * touches Stripe's API. Making the default suite depend on a third party's
 * network — and create objects in someone's Stripe account — would change what
 * `pnpm test:integration` means, so this file skips unless asked:
 *
 *   MARKII_STRIPE_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *     vitest run --project integration stripe-fee-invoice
 *
 * It additionally refuses a live key. Creating a subscription and charging a
 * card is fine against `sk_test_`; against `sk_live_` it is a real charge to a
 * real card, which no test may do.
 *
 * **What is simulated and what is not.** The subscription is created directly
 * against Stripe and the org's mirror is seeded to match, rather than going
 * through `POST /api/billing/subscription`. That route creates the subscription
 * `default_incomplete` and hands a client secret to Stripe Elements — a browser
 * step no integration test can perform — and the `incomplete → active`
 * transition normally arrives by webhook. Seeding the mirror isolates the thing
 * under test: whether Markii can put a correct fee line on a real invoice. The
 * subscription and the invoice it rides on are genuinely real.
 */

const ENABLED = process.env.MARKII_STRIPE_TESTS === "1";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const IS_TEST_KEY = KEY.startsWith("sk_test") || KEY.startsWith("rk_test");

const STRIPE = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2025-03-31.basil";

async function stripe<T = any>(
  path: string,
  init?: { method?: string; form?: Record<string, string> },
): Promise<T> {
  const res = await fetch(`${STRIPE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${KEY}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${path} → ${res.status}: ${json?.error?.message ?? "unknown"}`);
  }
  return json as T;
}

describe.skipIf(!ENABLED || !IS_TEST_KEY)("threshold fee → real Stripe invoice", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let customerId: string;
  let subscriptionId: string;
  let assessmentId: string;

  /** A finished period, so the assessment is one the scheduler could have closed. */
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  /** $2,500 over the growth threshold at 50bps physical → $12.50. */
  const FEE_MINOR = 12_50;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "stripefee");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    await createTestStore(cleanup, "stripefee", { orgId });

    // ---- A real, active subscription on Markii's own platform account -----
    const customer = await stripe<{ id: string }>("/customers", {
      method: "POST",
      form: { name: `Markii integration test ${orgId}`, "metadata[markii_org_id]": orgId },
    });
    customerId = customer.id;

    /**
     * Stripe's shared test card token. Attaching and defaulting it is what lets
     * the subscription settle immediately instead of sitting `incomplete`.
     *
     * **Attach returns a new id.** `pm_card_visa` is a shared token, not a
     * payment method belonging to this customer; the attach mints a customer-
     * scoped `pm_…` and defaulting to the token instead is rejected.
     */
    const attached = await stripe<{ id: string }>(`/payment_methods/pm_card_visa/attach`, {
      method: "POST",
      form: { customer: customerId },
    });
    await stripe(`/customers/${customerId}`, {
      method: "POST",
      form: { "invoice_settings[default_payment_method]": attached.id },
    });

    const price = await stripe<{ data: { id: string }[] }>(
      "/prices?lookup_keys[]=markii_growth_month&active=true&limit=1",
    );
    if (!price.data[0]) {
      throw new Error(
        "No active Price with lookup key markii_growth_month. Run `pnpm stripe:prices --apply` first.",
      );
    }

    const subscription = await stripe<{ id: string; status: string }>("/subscriptions", {
      method: "POST",
      form: {
        customer: customerId,
        "items[0][price]": price.data[0].id,
        "metadata[markii_org_id]": orgId,
      },
    });
    subscriptionId = subscription.id;
    expect(subscription.status).toBe("active");

    /**
     * Seed the mirror to match Stripe. In production the webhook does this;
     * here it is setup, not the thing under test.
     */
    await sql`update organizations
      set stripe_customer_id = ${customerId},
          stripe_subscription_id = ${subscriptionId},
          subscription_status = 'active',
          plan_id = 'growth',
          currency = 'USD'
      where id = ${orgId}`;

    // ---- A closed assessment with a real fee owing ------------------------
    assessmentId = `fee_stripetest_${Date.now()}`;
    await sql`insert into fee_assessments
      (id, org_id, period_start, period_end, plan_id, product_class, threshold_minor,
       overage_rate_bps, t12_net_sales_minor, period_net_sales_minor, billable_minor,
       fee_minor, currency, record_count)
      values (${assessmentId}, ${orgId}, ${periodStart}, ${periodEnd}, 'growth', 'physical',
       5000000, 50, 5250000, 250000, 250000, ${FEE_MINOR}, 'USD', 1)`;
  }, 60_000);

  afterAll(async () => {
    // Cancelling first: deleting a customer with an active subscription is
    // allowed but leaves the subscription in a state nobody asked for.
    if (subscriptionId) {
      await stripe(`/subscriptions/${subscriptionId}`, { method: "DELETE" }).catch(() => {});
    }
    if (customerId) {
      // Deleting the customer discards the pending invoice item with it.
      await stripe(`/customers/${customerId}`, { method: "DELETE" }).catch(() => {});
    }
    await sql`delete from fee_assessments where org_id = ${orgId}`;
    await cleanup.run();
  }, 60_000);

  it("raises a real invoice item and records the id it got back", async () => {
    const res = await merchant.post("/api/actions/billing.invoiceAssessments", {
      assessmentIds: [assessmentId],
    });

    expect(res.status).toBe(200);
    expect(res.json.result.charging).toBe(true);
    expect(res.json.result.chargedMinor).toBe(FEE_MINOR);
    expect(res.json.result.skipped).toEqual([]);

    const [row] = await sql`select invoiced, invoiced_at, stripe_invoice_item_id
      from fee_assessments where id = ${assessmentId}`;
    expect(row.invoiced).toBe(true);
    expect(row.invoiced_at).toBeTruthy();
    expect(row.stripe_invoice_item_id).toMatch(/^ii_/);
  });

  /**
   * Asserted against Stripe, not against the response that claimed it. Reading
   * a write back through the code that made it only proves the code agrees with
   * itself — and the whole point of this file is the boundary.
   */
  it("puts the right amount, currency, and explanation on the line", async () => {
    const [row] = await sql`select stripe_invoice_item_id from fee_assessments
      where id = ${assessmentId}`;

    const item = await stripe<{
      amount: number;
      currency: string;
      description: string;
      customer: string;
      metadata: Record<string, string>;
    }>(`/invoiceitems/${row.stripe_invoice_item_id}`);

    expect(item.amount).toBe(FEE_MINOR);
    expect(item.currency).toBe("usd");
    expect(item.customer).toBe(customerId);
    // The merchant must be able to check the number against their own records.
    expect(item.description).toMatch(/threshold fee/i);
    expect(item.description).toMatch(/physical/);
    expect(item.description).toMatch(/0\.50%/);
    // Links back to the assessment whose `workings` explain it in full.
    expect(item.metadata.markii_assessment_id).toBe(assessmentId);
  });

  /**
   * The item is *pending* — it rides onto the next subscription invoice rather
   * than drawing one of its own. Billing separately would mean two invoices a
   * month for one relationship and two dunning paths.
   */
  it("leaves the item pending rather than invoicing it separately", async () => {
    const [row] = await sql`select stripe_invoice_item_id from fee_assessments
      where id = ${assessmentId}`;

    const item = await stripe<{ invoice: string | null }>(
      `/invoiceitems/${row.stripe_invoice_item_id}`,
    );
    expect(item.invoice).toBeNull();

    // And it is genuinely queued for the merchant's next invoice.
    const upcoming = await stripe<{ lines: { data: { amount: number; description: string }[] } }>(
      `/invoices/create_preview?subscription=${subscriptionId}`,
      { method: "POST" },
    );
    const feeLine = upcoming.lines.data.find((l) => /threshold fee/i.test(l.description ?? ""));
    expect(feeLine).toBeTruthy();
    expect(feeLine!.amount).toBe(FEE_MINOR);
  });

  /**
   * **The dispute this is written to prevent.** The caller writes
   * `invoiced = true` in a transaction that can roll back after Stripe has
   * already accepted the item, so a retry must collapse onto the first item
   * rather than billing the merchant twice for one period.
   */
  it("refuses to bill the same assessment twice", async () => {
    const res = await merchant.post("/api/actions/billing.invoiceAssessments", {
      assessmentIds: [assessmentId],
    });

    expect(res.status).toBe(200);
    expect(res.json.result.charging).toBe(false);
    expect(res.json.result.chargedMinor).toBe(0);
    expect(res.json.result.billed).toEqual([]);

    /**
     * **The assertion that matters**, and it is made against Stripe rather than
     * against the response that would be reporting on itself: exactly one fee
     * line exists, not two.
     *
     * Note `skipped` is empty rather than carrying "already invoiced". The
     * action pre-filters to `invoiced = false`, so an already-billed row never
     * reaches `assessmentBillable` and its refusal for that case is defence in
     * depth for other callers. The money behaviour is right; the reporting is
     * quieter than `fee-invoice.ts` intends, and that is noted rather than
     * asserted as correct.
     */
    const items = await stripe<{ data: { id: string }[] }>(
      `/invoiceitems?customer=${customerId}&limit=100`,
    );
    expect(items.data).toHaveLength(1);
  });
});

describe.skipIf(ENABLED && IS_TEST_KEY)("threshold fee → real Stripe invoice (skipped)", () => {
  it("explains why it did not run", () => {
    // A silent skip reads as a pass. This is the only assertion in the file
    // that runs by default, and it exists so the reason is visible.
    console.info(
      !ENABLED
        ? "  skipped: set MARKII_STRIPE_TESTS=1 to exercise the real Stripe invoice path"
        : "  skipped: STRIPE_SECRET_KEY is not a test key — refusing to charge a live card",
    );
    expect(true).toBe(true);
  });
});
