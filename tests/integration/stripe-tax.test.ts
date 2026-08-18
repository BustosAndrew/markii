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

/**
 * Stripe Tax reaching **real Stripe** (§18.6, D45).
 *
 * Everything up to the API boundary is already proven: the arithmetic in
 * `lib/commerce/tax.test.ts`, the breakdown mapping in
 * `lib/payments/stripe-tax.test.ts`, and the refusals in `pricing.test.ts` —
 * which run in an environment with no connected account, so `stripeTax` gives
 * up before Stripe is ever called. **The boundary itself was unproven**: nothing
 * had shown that a calculation reaches Stripe, that a transaction is created
 * from it, or that a refund reverses one.
 *
 * That gap matters more here than elsewhere, because the transaction is the half
 * a merchant *files taxes with* and its absence is silent — the shopper is
 * charged correctly either way, and the merchant discovers the missing record at
 * filing time.
 *
 * **Opt-in and separate**, exactly like `stripe-fee-invoice.test.ts`: no other
 * test touches Stripe's API, and making the default suite depend on a third
 * party's network would change what `pnpm test:integration` means.
 *
 *   MARKII_STRIPE_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *     vitest run --project integration stripe-tax
 *
 * It refuses a live key. Everything below creates objects on a connected account
 * and files tax transactions against it; against `sk_live_` those would be real
 * entries in a real company's tax reports.
 *
 * **What is real and what is stood in for.** The connected account, its Stripe
 * Tax activation, its registration, the calculation, the transaction, and the
 * reversal are all genuinely created at Stripe. What is stood in for is the
 * OAuth handshake: the `integrations` row is written directly rather than
 * completed through Stripe Connect's browser flow, which no integration test can
 * perform. The account it names is real, so every call this exercises still goes
 * to a real connected account.
 *
 * **Assertions are made against Stripe, not against the response that caused
 * them.** Reading back our own JSON would prove only that we echoed ourselves —
 * the lesson `stripe-fee-invoice.test.ts` records.
 */

const ENABLED = process.env.MARKII_STRIPE_TESTS === "1";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const IS_TEST_KEY = KEY.startsWith("sk_test") || KEY.startsWith("rk_test");

const STRIPE = "https://api.stripe.com/v1";

async function stripe<T = any>(
  path: string,
  init?: { method?: string; form?: Record<string, string>; account?: string },
): Promise<T> {
  const res = await fetch(`${STRIPE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(init?.account ? { "Stripe-Account": init.account } : {}),
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe ${path} -> ${res.status}: ${(json as any)?.error?.message ?? "unknown"}`);
  }
  return json as T;
}

const describeMaybe = ENABLED && IS_TEST_KEY ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    "\n  stripe-tax: SKIPPED. Set MARKII_STRIPE_TESTS=1 to run it against a test-mode key.\n",
  );
} else if (!IS_TEST_KEY) {
  console.log(
    "\n  stripe-tax: SKIPPED. STRIPE_SECRET_KEY is not a test key — this file files real tax\n" +
      "  transactions and creates a connected account, neither of which may happen on a live key.\n",
  );
}

describeMaybe("Stripe Tax against real Stripe", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();

  let slug: string;
  let site: any;
  let p1: any;
  let orgId: string;
  let locationId: number;
  let accountId: string;
  let variantId: number;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  /** Colorado: a real destination-based sales-tax state, and it taxes delivery. */
  const ADDRESS = {
    line1: "1 Test St",
    city: "Denver",
    province: "CO",
    postalCode: "80202",
    country: "US",
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "stripetax");
    cleanup.merchantEmails.push(email);
    const me = await merchant.get("/api/me");
    orgId = me.json.org.id;

    const store = await createTestStore(cleanup, "stripetax", { orgId });
    slug = store.slug;
    site = store.site;
    [p1] = store.products;

    const [loc] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Tax Location', true) returning *`;
    locationId = loc.id;
    cleanup.locationIds.push(loc.id);

    const [v] = await sql`insert into variants (product_id, title, option_values, price_minor,
      weight_grams, requires_shipping, inventory_policy)
      values (${p1.id}, 'Taxable', ${sql.json({ Tax: "yes" })}, 5000, 100, true, 'continue')
      returning *`;
    variantId = v.id;
    cleanup.variantIds.push(v.id);
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type)
      values (${v.id}, ${locationId}, 100, 'stripe tax seed', 'system')`;

    const [zone] = await sql`insert into shipping_zones (site_id, name, countries)
      values (${site.id}, 'US', '["US"]'::jsonb) returning *`;
    cleanup.shippingZoneIds.push(zone.id);
    await sql`insert into shipping_rates (zone_id, name, type, price_minor)
      values (${zone.id}, 'Standard', 'flat', 800)`;

    /**
     * A real connected account with Stripe Tax genuinely turned on.
     *
     * Tax starts `pending` with `head_office` missing and becomes `active` only
     * once an address is set — which is exactly the state `GET /api/settings/tax`
     * reports as `status: "pending"`, so this setup also demonstrates that
     * surface is describing something real.
     */
    const account = await stripe<{ id: string }>("/accounts", {
      method: "POST",
      form: { type: "standard", country: "US", email: `markii-tax-test+${Date.now()}@example.test` },
    });
    accountId = account.id;

    await stripe("/tax/settings", {
      method: "POST",
      account: accountId,
      form: {
        "head_office[address][country]": "US",
        "head_office[address][state]": "CO",
        "head_office[address][city]": "Denver",
        "head_office[address][postal_code]": "80202",
        "head_office[address][line1]": "1 Test St",
        "defaults[tax_code]": "txcd_99999999",
      },
    });

    /**
     * **Without a registration Stripe Tax calculates a legitimate zero
     * everywhere** — the trap D45 names, and the reason this file would quietly
     * prove nothing if it were omitted: every assertion about a tax amount would
     * be comparing 0 to 0 and passing.
     */
    await stripe("/tax/registrations", {
      method: "POST",
      account: accountId,
      form: {
        country: "US",
        "country_options[us][state]": "CO",
        "country_options[us][type]": "state_sales_tax",
        active_from: "now",
      },
    });

    // Stands in for the OAuth handshake. The account it names is real.
    await sql`insert into integrations (id, org_id, provider, status, config)
      values (${`int_test_${Date.now()}`}, ${orgId}, 'stripe', 'connected',
              ${sql.json({ accountId, chargesEnabled: "true" })})
      on conflict (org_id, provider) do update set status = 'connected',
        config = ${sql.json({ accountId, chargesEnabled: "true" })}`;

    await sql`insert into tax_settings (site_id, provider, prices_include_tax)
      values (${site.id}, 'stripe', false)
      on conflict (site_id) do update set provider = 'stripe', prices_include_tax = false`;
  }, 180_000);

  afterAll(async () => {
    await sql`delete from integrations where org_id = ${orgId} and provider = 'stripe'`;
    await cleanup.run();
    /**
     * The connected account is deliberately **not** deleted. Its tax
     * transactions are the merchant-side record this file exists to create, and
     * a test that files something then destroys the evidence cannot be inspected
     * when it fails. Test-mode accounts are free and removable from the Stripe
     * dashboard.
     */
  }, 120_000);

  /** A cart holding the taxable variant with a shipping rate selected. */
  async function taxedCart(quantity = 1) {
    const c = await shopper.post(cart(), { productId: p1.id, variantId, quantity });
    await trackCart(cleanup, c.json.token);
    const token: string = c.json.token;

    await shopper.patch(cart(`/${token}`), { shippingAddress: ADDRESS });
    const rates = await shopper.post(cart(`/${token}/shipping-rates`), { address: ADDRESS });
    const standard = rates.json.rates?.find((r: any) => r.name === "Standard");
    if (!standard) throw new Error(`no Standard rate quoted: ${JSON.stringify(rates.json)}`);
    await shopper.patch(cart(`/${token}`), { shippingRateId: standard.id });
    return token;
  }

  it("calculates real Colorado tax on goods and delivery", async () => {
    const token = await taxedCart(1);
    const g = await shopper.get(cart(`/${token}`));

    expect(g.json.tax.state).toBe("calculated");
    /**
     * A positive amount is the assertion that matters most. Zero is what an
     * unregistered account, a silently-failing call, and a fabricated fallback
     * would all produce alike — the one result that would let this whole file
     * pass while proving nothing.
     */
    expect(g.json.tax.amountMinor).toBeGreaterThan(0);
    expect(g.json.totalState).toBe("final");
    expect(g.json.totalMinor).toBe(5000 + 800 + g.json.tax.amountMinor);

    /**
     * Colorado taxes goods and delivery at different rates, so real Stripe
     * returns more than one non-zero row here — and several zero-amount rows
     * beside them for jurisdictions it considered and cleared. Those must not
     * reach a receipt as "0%" lines a shopper has to decide are not a mistake.
     */
    expect(g.json.tax.breakdown.length).toBeGreaterThan(0);
    for (const row of g.json.tax.breakdown) {
      expect(row.amountMinor).not.toBe(0);
      expect(row.rateBps).toBeGreaterThan(0);
      expect(typeof row.name).toBe("string");
      expect(row.name.length).toBeGreaterThan(0);
    }
    // The parts must sum to the whole, or the receipt disagrees with the charge.
    expect(g.json.tax.breakdown.reduce((s: number, r: any) => s + r.amountMinor, 0)).toBe(
      g.json.tax.amountMinor,
    );
  }, 120_000);

  it("caches the calculation on the cart instead of billing the merchant twice", async () => {
    const token = await taxedCart(1);
    await shopper.get(cart(`/${token}`));

    const [first] = await sql`select tax_calculation_id, tax_calculation_fingerprint,
      tax_calculation_expires_at, tax_calculation_result from carts where token = ${token}`;
    expect(first.tax_calculation_id).toMatch(/^taxcalc_/);
    expect(first.tax_calculation_fingerprint).toBeTruthy();
    expect(first.tax_calculation_expires_at).toBeTruthy();
    expect(first.tax_calculation_result.taxAmountMinor).toBeGreaterThan(0);

    // Re-pricing an unchanged cart must reuse it. A new id here means every page
    // view charges the merchant for another calculation.
    await shopper.get(cart(`/${token}`));
    const [second] = await sql`select tax_calculation_id from carts where token = ${token}`;
    expect(second.tax_calculation_id).toBe(first.tax_calculation_id);

    /**
     * Changing the destination must **not** reuse it. This is the direction that
     * would silently over- or under-charge a shopper, and it is why the
     * fingerprint carries the postal code: US rates are decided below the state
     * line, so two ZIPs in one state are two different taxes.
     */
    await shopper.patch(cart(`/${token}`), { shippingAddress: { ...ADDRESS, postalCode: "80301" } });
    await shopper.get(cart(`/${token}`));
    const [third] = await sql`select tax_calculation_id, tax_calculation_fingerprint
      from carts where token = ${token}`;
    expect(third.tax_calculation_fingerprint).not.toBe(first.tax_calculation_fingerprint);
    expect(third.tax_calculation_id).not.toBe(first.tax_calculation_id);
  }, 180_000);

  it("files the sale as a real Stripe Tax transaction, and reverses it on refund", async () => {
    const token = await taxedCart(1);
    const priced = await shopper.get(cart(`/${token}`));
    const taxMinor: number = priced.json.tax.amountMinor;
    expect(taxMinor).toBeGreaterThan(0);

    const session = await shopper.post(checkout("/session"), { cartToken: token, rail: "x402" });
    expect(session.status).toBe(201);
    cleanup.checkoutSessionIds.push(session.json.id);

    // Frozen with the quote: the transaction must be built from the calculation
    // the shopper actually paid against, not whatever the cart holds later.
    const [frozen] = await sql`select tax_calculation_id, tax_minor from checkout_sessions
      where id = ${session.json.id}`;
    expect(frozen.tax_calculation_id).toMatch(/^taxcalc_/);
    expect(frozen.tax_minor).toBe(taxMinor);

    const paid = await shopper.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: `0xtax${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`,
    });
    expect(paid.status).toBe(200);
    const orderId: number = paid.json.orderId;
    await trackOrderCascade(cleanup, orderId);

    const [order] = await sql`select tax_transaction_id, tax_minor, amount_cents
      from orders where id = ${orderId}`;
    expect(order.tax_transaction_id).toMatch(/^tax_/);

    /**
     * **Read back from Stripe, not from our own row.** Asserting that the id we
     * stored equals the id we stored proves nothing. This proves the transaction
     * exists on the merchant's account and references this order.
     */
    const txn = await stripe<any>(`/tax/transactions/${order.tax_transaction_id}`, {
      account: accountId,
    });
    expect(txn.reference).toBe(`markii_order_${orderId}`);
    expect(txn.currency).toBe("usd");
    expect(txn.type).toBe("transaction");

    // --- the refund reverses it ---------------------------------------------

    const [line] = await sql`select id from order_lines where order_id = ${orderId} limit 1`;
    const refund = await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: line.id, quantity: 1 }],
      shippingMinor: 800,
    });
    expect(refund.status).toBe(200);
    const refundId: number = refund.json.result.refundId;

    /**
     * The reversal is a post-commit `ctx.effect`, so it lands just after the
     * action returns rather than inside it. Polled rather than assumed — and
     * bounded, so a failure reads as "no reversal was recorded" instead of
     * hanging the suite.
     */
    let reversalId: string | null = null;
    for (let i = 0; i < 20 && !reversalId; i++) {
      const [row] = await sql`select tax_reversal_id from refunds where id = ${refundId}`;
      reversalId = row?.tax_reversal_id ?? null;
      if (!reversalId) await new Promise((r) => setTimeout(r, 500));
    }
    expect(reversalId).toMatch(/^tax_/);

    const reversal = await stripe<any>(`/tax/transactions/${reversalId}`, { account: accountId });
    expect(reversal.type).toBe("reversal");
    expect(reversal.reference).toBe(`markii_refund_${refundId}`);
    // A reversal subtracts, so Stripe records which transaction it undoes.
    expect(reversal.reversal?.original_transaction).toBe(order.tax_transaction_id);
  }, 240_000);
});
