import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, sql, trackCart, trackOrderCascade } from "./helpers";

/**
 * Discounts, shipping, tax, and the metering base (§18.5, §18.6, §17).
 *
 * The through-line is D33: a money component carries a `state`, and only a
 * component whose absence would cost someone real money blocks a sale.
 */
describe("pricing", () => {
  const client = new Client();
  const cleanup = new Cleanup();
  let slug: string;
  let site: any;
  let p1: any;
  let p2: any;
  let shipVariant: any;
  let locationId: number;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  const mkDiscount = async (row: Record<string, unknown>) => {
    const [d] = await sql`insert into discounts ${sql({ site_id: site.id, ...row } as any)}
      returning *`;
    cleanup.discountIds.push(d.id);
    return d;
  };

  beforeAll(async () => {
    const store = await createTestStore(cleanup, "pricing");
    slug = store.slug;
    site = store.site;
    [p1, p2] = store.products;

    const [loc] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Pricing Location', true) returning *`;
    locationId = loc.id;
    cleanup.locationIds.push(loc.id);

    const [v] = await sql`insert into variants (product_id, title, option_values, price_minor,
      weight_grams, requires_shipping, inventory_policy)
      values (${p1.id}, 'Shippable', '{"Pricing":"ship"}'::jsonb, 2000, 500, true, 'continue')
      returning *`;
    shipVariant = v;
    cleanup.variantIds.push(v.id);
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type)
      values (${v.id}, ${locationId}, 100, 'pricing seed', 'system')`;

    const [zone] = await sql`insert into shipping_zones (site_id, name, countries)
      values (${site.id}, 'Test US', '["US"]'::jsonb) returning *`;
    cleanup.shippingZoneIds.push(zone.id);
    await sql`insert into shipping_rates (zone_id, name, type, price_minor)
      values (${zone.id}, 'Standard', 'flat', 800)`;
    await sql`insert into shipping_rates (zone_id, name, type, price_minor, min_subtotal_minor)
      values (${zone.id}, 'Free over 50', 'free_over_threshold', 0, 5000)`;
  });

  afterAll(async () => {
    await cleanup.run();
  });

  /** A cart holding shippable items, with an address and a chosen rate. */
  async function shippableCart(quantity: number) {
    const c = await client.post(cart(), {
      productId: p1.id,
      variantId: shipVariant.id,
      quantity,
    });
    await trackCart(cleanup, c.json.token);
    const rates = await client.post(cart(`/${c.json.token}/shipping-rates`), {
      address: { country: "US", line1: "1 Test St", city: "Denver", province: "CO" },
    });
    return { token: c.json.token as string, rates: rates.json };
  }

  describe("shipping", () => {
    it("blocks checkout when a shippable cart has no rate selected", async () => {
      const { token } = await shippableCart(1);
      const g = await client.get(cart(`/${token}`));

      expect(g.json.shipping.state).toBe("not_configured");
      expect(g.json.totalState).toBe("provisional");

      const s = await client.post(checkout("/session"), { cartToken: token, rail: "x402" });
      expect(s.status).toBe(409);
      expect(JSON.stringify(s.json)).toMatch(/shipping/i);
    });

    it("prices a selected rate and makes the total final", async () => {
      const { token, rates } = await shippableCart(1);
      const standard = rates.rates.find((r: any) => r.name === "Standard");

      await client.patch(cart(`/${token}`), { shippingRateId: standard.id });
      const g = await client.get(cart(`/${token}`));

      expect(g.json.shipping.state).toBe("calculated");
      expect(g.json.shipping.amountMinor).toBe(800);
      expect(g.json.totalMinor).toBe(2000 + 800);
      expect(g.json.totalState).toBe("final");
    });

    it("withholds a free-shipping rate below its threshold and offers it above", async () => {
      // D35: minSubtotalMinor is an eligibility bound, not a discount line.
      const below = await shippableCart(1); // 2000
      expect(below.rates.rates.find((r: any) => r.type === "free_over_threshold")).toBeUndefined();

      const above = await shippableCart(3); // 6000
      const free = above.rates.rates.find((r: any) => r.type === "free_over_threshold");
      expect(free).toBeDefined();
      expect(free.priceMinor).toBe(0);
    });

    it("withdraws free shipping when the cart shrinks below the threshold", async () => {
      const { token, rates } = await shippableCart(3);
      const free = rates.rates.find((r: any) => r.type === "free_over_threshold");
      await client.patch(cart(`/${token}`), { shippingRateId: free.id });

      let g = await client.get(cart(`/${token}`));
      expect(g.json.shipping.state).toBe("calculated");
      expect(g.json.totalMinor).toBe(6000);

      await client.patch(cart(`/${token}`), {
        setQuantity: { lineId: g.json.lines[0].id, quantity: 1 },
      });
      g = await client.get(cart(`/${token}`));

      // The selection stopped applying. It must not silently stay free.
      expect(g.json.shipping.state).toBe("not_configured");
      expect(g.json.totalState).toBe("provisional");
    });

    it("does not ship to an unserved country", async () => {
      const { token } = await shippableCart(1);
      const r = await client.post(cart(`/${token}/shipping-rates`), {
        address: { country: "JP", line1: "1 Test St", city: "Tokyo" },
      });
      expect(r.json.state).toBe("no_zone");
      expect(r.json.rates).toHaveLength(0);
    });
  });

  describe("tax", () => {
    afterAll(async () => {
      await sql`delete from tax_settings where site_id = ${site.id}`;
    });

    it("adds no tax line when the store has configured none", async () => {
      await sql`delete from tax_settings where site_id = ${site.id}`;
      const { token, rates } = await shippableCart(1);
      await client.patch(cart(`/${token}`), {
        shippingRateId: rates.rates.find((r: any) => r.name === "Standard").id,
      });

      const g = await client.get(cart(`/${token}`));
      expect(g.json.tax.state).toBe("none");
      // `none` never blocks — the store's listed prices stand.
      expect(g.json.totalState).toBe("final");
    });

    it("calculates exclusive tax on subtotal plus shipping", async () => {
      await sql`insert into tax_settings (site_id, provider, prices_include_tax, manual_rates)
        values (${site.id}, 'manual', false,
          ${sql.json([{ country: "US", province: "CO", rateBps: 875, name: "CO" }])})
        on conflict (site_id) do update set provider = 'manual', prices_include_tax = false,
          manual_rates = ${sql.json([{ country: "US", province: "CO", rateBps: 875, name: "CO" }])}`;

      const { token, rates } = await shippableCart(2); // 4000
      await client.patch(cart(`/${token}`), {
        shippingRateId: rates.rates.find((r: any) => r.name === "Standard").id,
      });

      const g = await client.get(cart(`/${token}`));
      // Most jurisdictions tax delivery, so the base is 4000 + 800 = 4800.
      expect(g.json.tax.state).toBe("calculated");
      expect(g.json.tax.amountMinor).toBe(Math.floor((4800 * 875 + 5000) / 10000));
      expect(g.json.totalMinor).toBe(4000 + 800 + g.json.tax.amountMinor);
    });

    it("blocks checkout for a destination the merchant has no rate for", async () => {
      const { token } = await shippableCart(1);
      await client.patch(cart(`/${token}`), {
        shippingAddress: { country: "JP", line1: "1 Test St", city: "Tokyo" },
      });

      const g = await client.get(cart(`/${token}`));
      expect(g.json.tax.state).toBe("not_configured");
      expect(g.json.totalState).toBe("provisional");

      const s = await client.post(checkout("/session"), { cartToken: token, rail: "x402" });
      expect(s.status).toBe(409);
    });

    it("extracts rather than adds when prices are tax-inclusive", async () => {
      await sql`update tax_settings set prices_include_tax = true where site_id = ${site.id}`;
      const { token, rates } = await shippableCart(2);
      await client.patch(cart(`/${token}`), {
        shippingRateId: rates.rates.find((r: any) => r.name === "Standard").id,
      });

      const g = await client.get(cart(`/${token}`));
      // Inclusive tax is already inside the price, so the total does not move.
      expect(g.json.tax.amountMinor).toBe(0);
      expect(g.json.totalMinor).toBe(4800);
      expect(g.json.tax.note).toMatch(/Includes/);
    });

    it("refuses to guess when Stripe Tax is selected but unavailable", async () => {
      await sql`update tax_settings set provider = 'stripe' where site_id = ${site.id}`;
      const { token, rates } = await shippableCart(1);
      await client.patch(cart(`/${token}`), {
        shippingRateId: rates.rates.find((r: any) => r.name === "Standard").id,
      });

      const g = await client.get(cart(`/${token}`));
      expect(g.json.tax.state).toBe("not_configured");
      expect(g.json.totalState).toBe("provisional");
    });
  });

  describe("discounts", () => {
    it("applies a percentage code, rounded half-up", async () => {
      await mkDiscount({
        code: "PCT15", title: "15% off", type: "percentage", percentage_bps: 1500,
      });
      const c = await client.post(cart(), { productId: p1.id, quantity: 2 });
      await trackCart(cleanup, c.json.token);
      const sub = p1.price_cents * 2;

      const r = await client.post(cart(`/${c.json.token}/discount`), { code: "pct15" });
      expect(r.json.codeResult.applied).toBe(true);
      expect(r.json.discount.amountMinor).toBe(Math.floor((sub * 1500 + 5000) / 10000));
      expect(r.json.totalMinor).toBe(sub - r.json.discount.amountMinor);
    });

    it("caps a fixed discount at the cart total and never goes negative", async () => {
      await mkDiscount({ code: "HUGE", title: "Huge", type: "fixed", value_minor: 500_00 });
      const c = await client.post(cart(), { productId: p1.id, quantity: 1 });
      await trackCart(cleanup, c.json.token);

      const r = await client.post(cart(`/${c.json.token}/discount`), { code: "HUGE" });
      expect(r.json.discount.amountMinor).toBe(p1.price_cents);
      expect(r.json.totalMinor).toBe(0);
    });

    it.each([
      ["expired", { code: "EXP", title: "E", type: "percentage", percentage_bps: 1000,
        ends_at: new Date(Date.now() - 86_400_000) }],
      ["not_started", { code: "SOON", title: "S", type: "percentage", percentage_bps: 1000,
        starts_at: new Date(Date.now() + 86_400_000) }],
      ["disabled", { code: "OFFD", title: "D", type: "percentage", percentage_bps: 1000,
        enabled: false }],
    ])("rejects a code with the specific reason %s", async (reason, row) => {
      await mkDiscount(row as Record<string, unknown>);
      const c = await client.post(cart(), { productId: p1.id, quantity: 1 });
      await trackCart(cleanup, c.json.token);

      const r = await client.post(cart(`/${c.json.token}/discount`), {
        code: (row as any).code,
      });
      expect(r.status).toBe(422);
      expect(r.json.codeResult.reason.code).toBe(reason);
      // A code that can never apply is not kept on the cart.
      expect(r.json.discountCodes).not.toContain((row as any).code);
    });

    it("keeps a below-minimum code, since the shopper can fix it", async () => {
      const min = p1.price_cents + 10_000;
      await mkDiscount({
        code: "BIGSPEND", title: "Min spend", type: "fixed", value_minor: 500,
        minimum_subtotal_minor: min,
      });
      const c = await client.post(cart(), { productId: p1.id, quantity: 1 });
      await trackCart(cleanup, c.json.token);

      const r = await client.post(cart(`/${c.json.token}/discount`), { code: "BIGSPEND" });
      expect(r.json.codeResult.reason.code).toBe("below_minimum");
      // Tells them how far off they are, not just that something is wrong.
      expect(r.json.codeResult.reason.minimumSubtotalMinor).toBe(min);
      expect(r.json.codeResult.reason.subtotalMinor).toBe(p1.price_cents);
      expect(r.json.discountCodes).toContain("BIGSPEND");
    });

    it("refuses to stack unless both discounts opt in", async () => {
      const a = await mkDiscount({
        code: "STACKA", title: "A", type: "percentage", percentage_bps: 1000,
      });
      const b = await mkDiscount({ code: "STACKB", title: "B", type: "fixed", value_minor: 100 });

      const c = await client.post(cart(), { productId: p1.id, quantity: 2 });
      await trackCart(cleanup, c.json.token);
      await client.post(cart(`/${c.json.token}/discount`), { code: "STACKA" });

      let r = await client.post(cart(`/${c.json.token}/discount`), { code: "STACKB" });
      expect(r.json.codeResult.reason.code).toBe("does_not_combine");

      // One-sided permission must not be enough.
      await sql`update discounts set combines_with_order = true where id = ${a.id}`;
      r = await client.post(cart(`/${c.json.token}/discount`), { code: "STACKB" });
      expect(r.json.codeResult.reason.code).toBe("does_not_combine");

      await sql`update discounts set combines_with_order = true where id = ${b.id}`;
      r = await client.post(cart(`/${c.json.token}/discount`), { code: "STACKB" });
      expect(r.json.codeResult.applied).toBe(true);
      expect(r.json.discounts).toHaveLength(2);
    });

    it("applies a product-scoped discount only to its own lines", async () => {
      await mkDiscount({
        code: "P1ONLY", title: "P1 only", type: "percentage", percentage_bps: 2000,
        applies_to_scope: "products", applies_to_ids: sql.json([p1.id]) as any,
      });
      const c = await client.post(cart(), { productId: p1.id, quantity: 1 });
      await trackCart(cleanup, c.json.token);
      await client.patch(cart(`/${c.json.token}`), { add: { productId: p2.id, quantity: 1 } });

      const r = await client.post(cart(`/${c.json.token}/discount`), { code: "P1ONLY" });
      expect(r.json.discount.amountMinor).toBe(Math.floor((p1.price_cents * 2000 + 5000) / 10000));
    });

    it("applies an automatic discount with nothing typed", async () => {
      const auto = await mkDiscount({
        code: null, title: "Auto sale", type: "percentage", percentage_bps: 500,
      });
      try {
        const c = await client.post(cart(), { productId: p1.id, quantity: 1 });
        await trackCart(cleanup, c.json.token);

        const g = await client.get(cart(`/${c.json.token}`));
        expect(g.json.discount.state).toBe("calculated");
        expect(g.json.discounts[0].code).toBeNull();
      } finally {
        await sql`delete from discounts where id = ${auto.id}`;
      }
    });

    it("makes shipping free without touching the subtotal", async () => {
      await mkDiscount({ code: "FREESHIP", title: "Free shipping", type: "free_shipping" });
      const { token, rates } = await shippableCart(1);
      await client.patch(cart(`/${token}`), {
        shippingRateId: rates.rates.find((r: any) => r.name === "Standard").id,
      });

      const r = await client.post(cart(`/${token}/discount`), { code: "FREESHIP" });
      expect(r.json.discount.amountMinor).toBe(0);
      expect(r.json.shipping.amountMinor).toBe(0);
      // The chosen service is still named, so the merchant's record is intact.
      expect(r.json.shipping.note).toMatch(/Standard/);
      expect(r.json.totalMinor).toBe(2000);
    });
  });

  describe("metering base (D36)", () => {
    it("meters net sales — excluding tax and shipping, net of discounts", async () => {
      await sql`delete from tax_settings where site_id = ${site.id}`;
      await mkDiscount({ code: "METER10", title: "10% off", type: "percentage", percentage_bps: 1000 });

      const { token, rates } = await shippableCart(2); // subtotal 4000
      await client.patch(cart(`/${token}`), {
        shippingRateId: rates.rates.find((r: any) => r.name === "Standard").id,
      });
      await client.post(cart(`/${token}/discount`), { code: "METER10" });

      const g = await client.get(cart(`/${token}`));
      const discount = g.json.discount.amountMinor;
      expect(discount).toBe(400);

      const session = await client.post(checkout("/session"), { cartToken: token, rail: "x402" });
      expect(session.status).toBe(201);
      cleanup.checkoutSessionIds.push(session.json.id);

      const done = await client.post(checkout(`/session/${session.json.id}/complete`), {
        paymentReference: `0xmeter${Date.now().toString(16)}`,
      });
      await trackOrderCascade(cleanup, done.json.orderId);

      const [order] = await sql`select amount_cents from orders where id = ${done.json.orderId}`;
      const usage = await sql`select * from usage_records where order_id = ${done.json.orderId}`;

      // Charged 4000 - 400 + 800 shipping = 4400.
      expect(order.amount_cents).toBe(4400);
      // Metered 4000 - 400 = 3600. docs/PRICING.md §4.1 excludes shipping.
      expect(usage[0].amount_minor).toBe(3600);
      // The assertion that would have caught the original bug: these differ.
      expect(usage[0].amount_minor).not.toBe(order.amount_cents);
    });

    it("records the redemption once, even on a retried completion", async () => {
      const d = await mkDiscount({
        code: "ONCE5", title: "5% off", type: "percentage", percentage_bps: 500,
      });
      const c = await client.post(cart(), { productId: p1.id, quantity: 1 });
      await trackCart(cleanup, c.json.token);
      await client.post(cart(`/${c.json.token}/discount`), { code: "ONCE5" });

      const session = await client.post(checkout("/session"), {
        cartToken: c.json.token,
        rail: "x402",
      });
      cleanup.checkoutSessionIds.push(session.json.id);

      const tx = `0xonce${Date.now().toString(16)}`;
      const done = await client.post(checkout(`/session/${session.json.id}/complete`), {
        paymentReference: tx,
      });
      await trackOrderCascade(cleanup, done.json.orderId);
      await client.post(checkout(`/session/${session.json.id}/complete`), { paymentReference: tx });

      const [count] = await sql`select count(*)::int c from discount_redemptions
        where discount_id = ${d.id}`;
      expect(count.c).toBe(1);

    });
  });
});
