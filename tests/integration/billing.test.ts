import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Cleanup,
  Client,
  createTestStore,
  signUpMerchant,
  sql,
  trackCart,
  trackOrderCascade,
} from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Billing and the threshold meter (§17, `docs/PRICING.md` §4).
 *
 * The fee arithmetic is unit-tested in `lib/billing/fees.test.ts`, including the
 * worked example from the pricing doc. What only a real request can show is that
 * the meter reads the **immutable usage ledger** written by real checkouts —
 * that a sale moves it, a refund credits it on the net-sales base rather than
 * the amount returned, and a test-mode order never touches it at all.
 */
describe("billing", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let slug: string;
  let site: any;
  let p1: any;
  let locationId: number;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "billing");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "billing", { orgId });
    slug = store.slug;
    site = store.site;
    [p1] = store.products;

    const [loc] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Billing Test Location', true) returning *`;
    locationId = loc.id;
    cleanup.locationIds.push(loc.id);
  });

  afterAll(async () => {
    await sql`delete from fee_assessments where org_id = ${orgId}`;
    await cleanup.run();
  });

  async function makeVariant(label: string, units: number, priceMinor: number) {
    const [v] = await sql`insert into variants (product_id, title, option_values, price_minor,
      weight_grams, requires_shipping, inventory_policy)
      values (${p1.id}, ${label}, ${sql.json({ Billing: label })}, ${priceMinor}, 100,
              false, 'deny') returning *`;
    cleanup.variantIds.push(v.id);
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type)
      values (${v.id}, ${locationId}, ${units}, 'test seed', 'system')`;
    return v;
  }

  async function buy(variantId: number, quantity: number) {
    const c = await shopper.post(cart(), { productId: p1.id, variantId, quantity });
    await trackCart(cleanup, c.json.token);
    const session = await shopper.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
    });
    expect(session.status).toBe(201);
    cleanup.checkoutSessionIds.push(session.json.id);

    const paid = await shopper.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: `0xbill${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`,
    });
    expect(paid.status).toBe(200);
    await trackOrderCascade(cleanup, paid.json.orderId);
    return paid.json.orderId as number;
  }

  it("reports not-yet-measured before a first sale, never zero", async () => {
    const res = await merchant.get("/api/billing/usage");
    expect(res.status).toBe(200);
    // A zero is a measurement; this is the absence of one.
    expect(res.json.dataSource).toBe("not_yet_measured");
    expect(res.json.trailing12NetSalesMinor).toBeNull();
    expect(res.json.periodNetSalesMinor).toBeNull();
    expect(res.json.feeAccruedMinor).toBeNull();
    expect(res.json.state).toBeNull();
  });

  it("says plainly that nothing is being charged", async () => {
    const res = await merchant.get("/api/billing/usage");
    /**
     * The meter shows numbers that look like a bill, so it has to say they are
     * not one — and **`charging` must not flip merely because a credential
     * exists**. An environment with `STRIPE_SECRET_KEY` set still charges
     * nothing until subscription billing is built, and this assertion is what
     * caught the meter claiming otherwise the moment a real key was added.
     */
    expect(res.json.billingStatus.charging).toBe(false);
    expect(res.json.billingStatus.reason).toMatch(
      /not connected|(nothing|not) is being charged/i,
    );
    expect(res.json.processorFeesNote).toMatch(/not part of your Markii bill/i);
  });

  it("moves the meter on a real sale, on the net-sales base", async () => {
    const v = await makeVariant("meter", 10, 25_00);
    await buy(v.id, 2);

    const res = await merchant.get("/api/billing/usage");
    expect(res.json.dataSource).toBe("production");
    // Net sales = subtotal − discounts. No tax or shipping on this rail.
    expect(res.json.trailing12NetSalesMinor).toBe(50_00);
    expect(res.json.periodNetSalesMinor).toBe(50_00);
    expect(res.json.currency).toBe("USD");
  });

  it("charges nothing far below the threshold", async () => {
    const res = await merchant.get("/api/billing/usage");
    expect(res.json.state).toBe("below");
    expect(res.json.billableThisPeriodMinor).toBe(0);
    expect(res.json.feeAccruedMinor).toBe(0);
  });

  it("labels a projection as a projection", async () => {
    const res = await merchant.get("/api/billing/usage");
    // §17: projections are never presented as owed. The basis travels with the
    // number so no surface can render it as a bill.
    expect(res.json.projectionBasis).toBe("run_rate_to_period_end");
    expect(typeof res.json.projectedPeriodFeeMinor).toBe("number");
  });

  it("credits a refund against the meter on the net-sales base", async () => {
    const before = await merchant.get("/api/billing/usage");
    const v = await makeVariant("refundmeter", 10, 40_00);
    const orderId = await buy(v.id, 1);

    const afterSale = await merchant.get("/api/billing/usage");
    expect(afterSale.json.trailing12NetSalesMinor).toBe(
      before.json.trailing12NetSalesMinor + 40_00,
    );

    const detail = await merchant.get(`/api/orders/${orderId}`);
    const refund = await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: detail.json.lines[0].id, quantity: 1 }],
    });
    expect(refund.json.ok).toBe(true);

    // Back where it started: the sale and its reversal are metered on the same
    // base, so a full refund nets to nothing.
    const afterRefund = await merchant.get("/api/billing/usage");
    expect(afterRefund.json.trailing12NetSalesMinor).toBe(before.json.trailing12NetSalesMinor);
  });

  it("never counts a test-mode record", async () => {
    const before = await merchant.get("/api/billing/usage");

    // Written directly, because production code cannot produce one on a live
    // store — which is the point: the guard exists at write time *and* here.
    await sql`insert into usage_records
      (id, org_id, site_id, type, amount_minor, currency, converted_minor, fx_rate,
       environment, dedupe_key, occurred_at)
      values (${`ur_test_${Date.now()}`}, ${orgId}, ${site.id}, 'sale', 999999, 'USD', 999999, 1,
              'test', ${`test:${Date.now()}`}, now())`;

    const after = await merchant.get("/api/billing/usage");
    expect(after.json.trailing12NetSalesMinor).toBe(before.json.trailing12NetSalesMinor);

    await sql`delete from usage_records where org_id = ${orgId} and environment = 'test'`;
  });

  it("refuses a merchant Stripe secret key instead of storing it", async () => {
    /**
     * A live `sk_` grants full control of a merchant's account — charges,
     * refunds, payouts, customer PII. Connect Standard (D4) needs only a
     * revocable connection and an `acct_` id, so this route accepts neither a
     * key nor anything else.
     */
    const res = await merchant.put("/api/integrations/stripe", { secretKey: "sk_live_notreal" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toMatch(/Connect Standard|never stores a merchant secret key/i);

    // And nothing was written.
    const rows = await sql`select config from integrations
      where org_id = ${orgId} and provider = 'stripe'`;
    for (const row of rows) expect(row.config?.secretKey).toBeUndefined();
  });

  it("reports the Connect connection without inventing one", async () => {
    const res = await merchant.get("/api/integrations");
    expect(res.status).toBe(200);

    const stripe = res.json.stripe;
    expect(stripe.mode).toBe("connect_standard");
    expect(stripe.status).toBe("not_connected");
    expect(stripe.accountId).toBeNull();
    /**
     * The load-bearing assertion: `chargesEnabled` must not be true because the
     * *platform* holds credentials. It is a fact about the merchant's own Stripe
     * account, and a storefront offering card checkout on the strength of a
     * platform key would fail the shopper after stock was already held.
     */
    expect(stripe.chargesEnabled).toBe(false);
    expect(stripe.payoutsEnabled).toBe(false);
    expect(stripe.requirementsDue).toEqual([]);
    // No secret is ever echoed back, under any key name.
    expect(JSON.stringify(stripe)).not.toMatch(/sk_/);
  });

  it("will not attach a Stripe account the merchant did not authorise", async () => {
    /**
     * The highest-severity failure available in this slice. Without a state
     * check, anyone who gets a signed-in merchant to load the callback with
     * *their* code attaches *their* Stripe account to *this* org — and every
     * card payment the store takes afterwards settles into it.
     */
    const start = await merchant.get("/api/integrations/stripe/connect");
    if (start.status === 503) return; // Connect not configured on this deployment

    const sent = new URL(start.json.url).searchParams.get("state") ?? "";
    expect(sent).toMatch(/^[0-9a-f]{64}$/);

    const raw = (query: string) =>
      fetch(`${BASE_URL}/api/integrations/stripe/callback?${query}`, {
        headers: { cookie: (merchant as any).cookie },
        redirect: "manual",
      });

    const forged = await raw(`code=ac_forged&state=${"0".repeat(64)}`);
    const forgedTo = decodeURIComponent(forged.headers.get("location") ?? "");
    expect(forgedTo).toMatch(/stripe=error/);
    expect(forgedTo).toMatch(/did not start here/i);

    // A stale state cannot be replayed indefinitely.
    await sql`update integrations
      set config = jsonb_set(config, '{oauthStateAt}',
        ${JSON.stringify(new Date(Date.now() - 31 * 60_000).toISOString())}::jsonb)
      where org_id = ${orgId} and provider = 'stripe'`;
    const stale = await raw(`code=ac_fake&state=${sent}`);
    expect(decodeURIComponent(stale.headers.get("location") ?? "")).toMatch(/expired/i);

    // Cancelling on Stripe's screen is a decision, not a failure.
    const cancelled = await raw(`error=access_denied&state=${sent}`);
    expect(cancelled.headers.get("location") ?? "").toMatch(/stripe=cancelled/);

    // Through all of that, no account was ever attached.
    const [row] = await sql`select config, status from integrations
      where org_id = ${orgId} and provider = 'stripe'`;
    expect(row?.config?.accountId).toBeUndefined();
    expect(row?.status).not.toBe("connected");
  });

  it("returns the plan catalog, marked proposed", async () => {
    const res = await merchant.get("/api/billing/plans");
    expect(res.status).toBe(200);
    expect(res.json.items.map((p: any) => p.planId)).toEqual(["starter", "growth", "scale"]);
    // Prices are proposals in docs/PRICING.md §3 and must not ship as settled.
    expect(res.json.status).toBe("proposed");
    // Competitor comparisons are factual claims needing a verifiedAt — omitted
    // rather than hardcoded from memory.
    expect(res.json.comparisons).toEqual([]);
  });

  it("returns entitlements, and no invented subscription", async () => {
    const res = await merchant.get("/api/billing/subscription");
    expect(res.status).toBe(200);
    expect(res.json.planId).toBe("starter");
    // D39: one threshold, applied separately to each class, and a rate per class.
    expect(res.json.entitlements.gmvThresholdMinor).toBe(1_000_00);
    expect(res.json.entitlements.overageRateBps).toEqual({ physical: 150, digital: 300 });
    // A fabricated `active` subscription is the most consequential lie
    // available here — a merchant would think they were covered.
    expect(res.json.subscription).toBeNull();
    expect(res.json.subscriptionState.code).toBe("configuration_required");
    expect(res.json.subscriptionState.charging).toBe(false);
  });

  it("refuses a plan change rather than granting paid capability for free", async () => {
    const res = await merchant.post("/api/billing/subscription", { planId: "scale" });
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("CONFIGURATION_REQUIRED");

    // And the plan really did not move.
    const after = await merchant.get("/api/billing/subscription");
    expect(after.json.planId).toBe("starter");
  });

  it("refuses to collect card details rather than returning a stub secret", async () => {
    const res = await merchant.post("/api/billing/payment-method", {});
    expect(res.status).toBe(503);
    // A fake client secret fails inside Stripe's own card element, after the
    // merchant has typed their card number.
    expect(res.json.error.code).toBe("CONFIGURATION_REQUIRED");
  });

  it("lists assessments rather than pretending they are invoices", async () => {
    const res = await merchant.get("/api/billing/invoices");
    expect(res.status).toBe(200);
    expect(res.json.invoices).toEqual([]);
    expect(res.json.invoicesState.code).toBe("configuration_required");
    expect(Array.isArray(res.json.assessments)).toBe(true);
  });

  it("keeps another org's sales out of this meter", async () => {
    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "billing-outsider");
    cleanup.merchantEmails.push(email);

    const theirs = await outsider.get("/api/billing/usage");
    // They have sold nothing, and this merchant's sales must not leak in.
    expect(theirs.json.dataSource).toBe("not_yet_measured");
  });
});
