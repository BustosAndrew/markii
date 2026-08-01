import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, refused, sql, signUpMerchant } from "./helpers";

/**
 * Tenancy and the merchant configuration surface (§16, §18.5, §18.6).
 *
 * Two real organizations, created through the real sign-up route. The point is
 * not that org B *sees nothing* — it is that org B cannot **write** to org A's
 * data, which is the failure that actually costs someone money. Cross-tenant
 * writes were a real bug found during Phase A org-scoping.
 */
describe("tenancy and merchant configuration", () => {
  const a = new Client();
  const b = new Client();
  const cleanup = new Cleanup();

  let emailA: string;
  let emailB: string;
  let siteA: number;
  let zoneA: number;
  let rateA: number;
  let discountA: number;

  beforeAll(async () => {
    ({ email: emailA } = await signUpMerchant(a, "org-a"));
    cleanup.merchantEmails.push(emailA);

    const site = await a.post("/api/sites", {
      name: `Tenancy A ${Date.now()}`,
      slug: `tenancy-a-${Date.now()}`,
    });
    siteA = site.json.id ?? site.json.site?.id;

    const zone = await a.invoke("shipping.createZone", {
      siteId: siteA,
      name: "UK",
      countries: ["gb"],
    });
    zoneA = zone.json.result.id;

    const rate = await a.invoke("shipping.createRate", {
      zoneId: zoneA,
      name: "UK Standard",
      type: "flat",
      priceMinor: 450,
    });
    rateA = rate.json.result.id;

    const discount = await a.invoke("discounts.create", {
      siteId: siteA,
      code: "TENANTA",
      title: "10% off",
      type: "percentage",
      percentageBps: 1000,
    });
    discountA = discount.json.result.id;

    ({ email: emailB } = await signUpMerchant(b, "org-b"));
    cleanup.merchantEmails.push(emailB);
  });

  afterAll(async () => {
    await cleanup.run();
  });

  describe("configuration validity is enforced by the registry", () => {
    it("normalises a country code to uppercase", async () => {
      const [zone] = await sql`select countries from shipping_zones where id = ${zoneA}`;
      expect(zone.countries).toEqual(["GB"]);
    });

    it("refuses a zone naming provinces but no country", async () => {
      const r = await a.invoke("shipping.createZone", {
        siteId: siteA,
        name: "Nowhere",
        provinces: ["ENG"],
      });
      expect(refused(r)).toBe(true);
    });

    it("refuses a rate whose bounds could never match", async () => {
      const r = await a.invoke("shipping.createRate", {
        zoneId: zoneA,
        name: "Impossible",
        type: "weight_based",
        priceMinor: 500,
        minWeightGrams: 5000,
        maxWeightGrams: 1000,
      });
      expect(refused(r)).toBe(true);
      expect(JSON.stringify(r.json)).toMatch(/never apply/);
    });

    it("refuses a free-shipping rate carrying a price that could never be charged", async () => {
      const r = await a.invoke("shipping.createRate", {
        zoneId: zoneA,
        name: "Free over 50",
        type: "free_over_threshold",
        priceMinor: 299,
        minSubtotalMinor: 5000,
      });
      expect(refused(r)).toBe(true);
    });

    it("validates an update against the merged rate, not just the patch", async () => {
      // Switching type without supplying the bounds the new type needs.
      const r = await a.invoke("shipping.updateRate", { rateId: rateA, type: "weight_based" });
      expect(refused(r)).toBe(true);
    });

    it("refuses a discount that is ambiguous about what it takes off", async () => {
      const r = await a.invoke("discounts.create", {
        siteId: siteA,
        title: "Both",
        type: "percentage",
        percentageBps: 1000,
        valueMinor: 500,
      });
      expect(refused(r)).toBe(true);
    });

    it("refuses a duplicate discount code", async () => {
      const r = await a.invoke("discounts.create", {
        siteId: siteA,
        code: "tenanta",
        title: "Duplicate",
        type: "fixed",
        valueMinor: 100,
      });
      expect(refused(r)).toBe(true);
    });

    it("refuses manual tax with no rates, which would block every checkout", async () => {
      const r = await a.invoke("tax.updateSettings", {
        siteId: siteA,
        provider: "manual",
        manualRates: [],
      });
      expect(refused(r)).toBe(true);
      expect(JSON.stringify(r.json)).toMatch(/every checkout/);
    });

    it("reports a selected-but-unusable tax provider as not operational", async () => {
      await a.invoke("tax.updateSettings", { siteId: siteA, provider: "stripe" });
      const r = await a.get(`/api/settings/tax?siteId=${siteA}`);
      expect(r.json.operational.ok).toBe(false);
      expect(r.json.disclaimer).toMatch(/does not provide tax advice/);
      await a.invoke("tax.updateSettings", { siteId: siteA, provider: "none" });
    });

    it("flags a zone with no rates rather than letting it look configured", async () => {
      const empty = await a.invoke("shipping.createZone", {
        siteId: siteA,
        name: "Empty",
        countries: ["FR"],
      });
      const r = await a.get(`/api/shipping/zones?siteId=${siteA}`);
      const zone = r.json.items.find((z: any) => z.id === empty.json.result.id);
      expect(zone.warning).toMatch(/refused/);
    });

    it("writes nothing on a dry run", async () => {
      const [before] = await sql`select count(*)::int c from shipping_rates where zone_id = ${zoneA}`;
      const r = await a.invoke(
        "shipping.createRate",
        { zoneId: zoneA, name: "Dry", type: "flat", priceMinor: 100 },
        { dryRun: true },
      );
      expect(r.json.ok).toBe(true);
      const [after] = await sql`select count(*)::int c from shipping_rates where zone_id = ${zoneA}`;
      expect(after.c).toBe(before.c);
    });
  });

  describe("org B cannot reach org A's data", () => {
    it("cannot list A's shipping zones", async () => {
      const r = await b.get(`/api/shipping/zones?siteId=${siteA}`);
      expect(r.json.items ?? []).toHaveLength(0);
    });

    it("cannot list or read A's discounts", async () => {
      const list = await b.get(`/api/discounts?siteId=${siteA}`);
      expect(list.json.items ?? []).toHaveLength(0);
      const one = await b.get(`/api/discounts/${discountA}`);
      expect(one.status).toBe(404);
    });

    it("cannot read A's tax settings", async () => {
      const r = await b.get(`/api/settings/tax?siteId=${siteA}`);
      expect(r.status).toBe(400);
    });

    it("cannot WRITE to A's shipping rate", async () => {
      const r = await b.invoke("shipping.updateRate", { rateId: rateA, priceMinor: 1 });
      expect(refused(r)).toBe(true);

      // Assert on the database, not the response: a refusal that still wrote
      // would look identical from the outside.
      const [row] = await sql`select price_minor from shipping_rates where id = ${rateA}`;
      expect(row.price_minor).toBe(450);
    });

    it("cannot WRITE to A's discount", async () => {
      const r = await b.invoke("discounts.update", { discountId: discountA, percentageBps: 9000 });
      expect(refused(r)).toBe(true);

      const [row] = await sql`select percentage_bps from discounts where id = ${discountA}`;
      expect(row.percentage_bps).toBe(1000);
    });

    it("cannot delete A's zone", async () => {
      const r = await b.invoke("shipping.deleteZone", { zoneId: zoneA });
      expect(refused(r)).toBe(true);

      const [row] = await sql`select count(*)::int c from shipping_zones where id = ${zoneA}`;
      expect(row.c).toBe(1);
    });

    it("cannot change A's tax settings", async () => {
      const r = await b.invoke("tax.updateSettings", {
        siteId: siteA,
        provider: "manual",
        manualRates: [{ country: "GB", rateBps: 0, name: "Zero" }],
      });
      expect(refused(r)).toBe(true);
    });

    it("cannot preview a discount against A's store", async () => {
      const r = await b.post("/api/discounts/validate", {
        siteId: siteA,
        codes: ["TENANTA"],
        subtotalMinor: 10_000,
      });
      expect(r.status).toBe(400);
    });
  });

  describe("previews write nothing", () => {
    it("validates a discount without consuming its usage allowance", async () => {
      const [before] = await sql`select count(*)::int c from discount_redemptions
        where discount_id = ${discountA}`;

      const r = await a.post("/api/discounts/validate", {
        siteId: siteA,
        codes: ["TENANTA"],
        subtotalMinor: 10_000,
      });
      expect(r.json.totalDiscountMinor).toBe(1000);
      expect(r.json.preview).toBe(true);

      const [after] = await sql`select count(*)::int c from discount_redemptions
        where discount_id = ${discountA}`;
      expect(after.c).toBe(before.c);
    });

    it("calculates tax as a preview", async () => {
      await a.invoke("tax.updateSettings", {
        siteId: siteA,
        provider: "manual",
        pricesIncludeTax: false,
        manualRates: [{ country: "GB", rateBps: 2000, name: "UK VAT" }],
      });
      const r = await a.post("/api/tax/calculate", {
        siteId: siteA,
        amountMinor: 10_000,
        address: { country: "GB" },
      });
      expect(r.json.amountMinor).toBe(2000);
      expect(r.json.totalMinor).toBe(12_000);
      expect(r.json.preview).toBe(true);
    });
  });

  describe("derived fields", () => {
    it("derives status and usage rather than storing them", async () => {
      const r = await a.get(`/api/discounts/${discountA}`);
      expect(r.json.status).toBe("active");
      expect(r.json.usedCount).toBe(0);

      await sql`insert into discount_redemptions (discount_id, order_id, amount_minor)
        values (${discountA}, null, 250)`;
      try {
        const after = await a.get(`/api/discounts/${discountA}`);
        expect(after.json.usedCount).toBe(1);
        expect(after.json.totalDiscountedMinor).toBe(250);
      } finally {
        await sql`delete from discount_redemptions where discount_id = ${discountA}`;
      }
    });

    it("reports a fully-redeemed code as exhausted", async () => {
      const limited = await a.invoke("discounts.create", {
        siteId: siteA,
        code: "LIMITED1",
        title: "One use",
        type: "fixed",
        valueMinor: 100,
        usageLimit: 1,
      });
      const id = limited.json.result.id;
      await sql`insert into discount_redemptions (discount_id, order_id, amount_minor)
        values (${id}, null, 100)`;

      const r = await a.get(`/api/discounts/${id}`);
      expect(r.json.exhausted).toBe(true);
    });
  });
});
