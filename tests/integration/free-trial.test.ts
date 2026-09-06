import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The free month, end to end (D45).
 *
 * `accountStanding` is a pure function and is unit-tested against a clock in
 * `lib/billing/standing.test.ts`. What only a real request can show is the span
 * this feature actually lives in — a check inside `invokeAction`, a storefront
 * loader, an async `assertPurchasable`, and a download route — and that span is
 * the whole feature. Every bug this repo has found lived there rather than in
 * the arithmetic (`tests/README.md`).
 *
 * **It is also the highest-consequence thing in the codebase to get wrong**: a
 * false positive takes every storefront offline. So the assertions come in
 * pairs — refused while expired, working again once standing returns — because
 * a gate that never opens passes a "does it block?" test perfectly.
 */
describe("free trial standing", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: any;
  let products: any[];

  /** Moves this org's trial without touching anyone else's. */
  const setTrial = (endsAt: Date | null) =>
    sql`update organizations set free_trial_ends_at = ${endsAt} where id = ${orgId}`;

  const past = new Date(Date.now() - 24 * 60 * 60_000);
  const future = new Date(Date.now() + 20 * 24 * 60 * 60_000);

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "trial");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    /**
     * Label deliberately not "trial": the store's name is rendered on the
     * halted page, and a fixture called "Test Store trial" made the
     * disclosure assertion below pass or fail on the fixture's own name
     * rather than on anything the page discloses.
     */
    const store = await createTestStore(cleanup, "standing", { orgId });
    site = store.site;
    products = store.products;
  });

  afterAll(async () => {
    await cleanup.run();
  });

  it("gives a new merchant a month, and says so on /api/me", async () => {
    const me = await merchant.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.json.standing.state).toBe("trialing");
    /**
     * Roughly a month — asserted as a range rather than a date so the test does
     * not fail on a month boundary or a leap year, which is the arithmetic the
     * unit test pins exactly.
     */
    expect(me.json.standing.daysLeft).toBeGreaterThan(26);
    expect(me.json.standing.daysLeft).toBeLessThanOrEqual(31);
  });

  it("serves the storefront and takes carts while the trial runs", async () => {
    const page = await fetch(`${BASE_URL}/_sites/${site.slug}/`);
    expect(page.status).toBe(200);

    const cart = await merchant.post(`/_sites/${site.slug}/api/cart`, {
      productId: products[0].id,
      quantity: 1,
    });
    expect(cart.status).toBeLessThan(400);
  });

  describe("once the month has run out", () => {
    beforeAll(async () => {
      await setTrial(past);
    });

    it("reports expired on /api/me, and reads still work", async () => {
      const me = await merchant.get("/api/me");
      /**
       * **A read must never be gated.** Holding a store is a commercial measure;
       * holding a merchant's own data hostage is a different thing entirely, and
       * this is the assertion that stops someone "tidying up" the gate into the
       * read path later.
       */
      expect(me.status).toBe(200);
      expect(me.json.standing.state).toBe("expired");

      const catalog = await merchant.get("/api/products");
      expect(catalog.status).toBe(200);
    });

    it("refuses a mutating action with 402 TRIAL_ENDED, not 403", async () => {
      const res = await merchant.post("/api/actions/catalog.setProductOptions", {
        productId: products[0].id,
        options: [],
      });
      /**
       * The status is the assertion, not merely that it failed. **403 would send
       * the dashboard's MFA step-up modal** after a second factor that cannot
       * help, and would tell an agent it lacks authority when it lacks a plan.
       */
      expect(res.status).toBe(402);
      expect(res.json.error?.code).toBe("TRIAL_ENDED");
    });

    it("still lets billing actions through, or the merchant is locked out", async () => {
      const res = await merchant.post("/api/actions/billing.setCancellation", {
        cancelAtPeriodEnd: true,
      });
      /**
       * This org has no subscription, so the action itself refuses — which is
       * exactly the proof wanted: it reached its own logic instead of being
       * stopped at the gate. Any status but 402 passes; 402 would mean
       * "subscribe to reinstate everything" is impossible because subscribing is
       * itself gated.
       */
      expect(res.status).not.toBe(402);
    });

    it("takes the storefront offline without disclosing why", async () => {
      const page = await fetch(`${BASE_URL}/_sites/${site.slug}/`);
      const body = (await page.text()).toLowerCase();

      /** The shopper is told the store is unavailable... */
      expect(body).toContain("temporarily paused");

      /**
       * ...and never why. Each of these is a phrase that would leak Markii's
       * commercial relationship with the merchant onto their customers' screens.
       */
      for (const leak of ["free month", "free trial", "unpaid", "billing", "expired"]) {
        expect(body, `storefront disclosed "${leak}"`).not.toContain(leak);
      }

      const product = await fetch(`${BASE_URL}/_sites/${site.slug}/p/${products[0].slug}`);
      expect(product.status).toBe(404);
    });

    it("stops taking money", async () => {
      const cart = await merchant.post(`/_sites/${site.slug}/api/cart`, {
        productId: products[0].id,
        quantity: 1,
      });
      expect(cart.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("once a plan is bought", () => {
    beforeAll(async () => {
      /**
       * Restoring the trial stands in for subscribing: both resolve to "in
       * standing" through the same derivation, and this needs no live Stripe
       * subscription to prove the gate reopens.
       */
      await setTrial(future);
    });

    /**
     * **The half that matters most.** A gate that blocks correctly but never
     * reopens is worse than no gate — the merchant pays and stays dark — and
     * nothing above this line would catch it.
     */
    it("brings the storefront, the catalog and checkout back", async () => {
      const me = await merchant.get("/api/me");
      expect(me.json.standing.state).toBe("trialing");

      const page = await fetch(`${BASE_URL}/_sites/${site.slug}/`);
      expect(page.status).toBe(200);

      const product = await fetch(`${BASE_URL}/_sites/${site.slug}/p/${products[0].slug}`);
      expect(product.status).toBe(200);

      const cart = await merchant.post(`/_sites/${site.slug}/api/cart`, {
        productId: products[0].id,
        quantity: 1,
      });
      expect(cart.status).toBeLessThan(400);
    });
  });

  /**
   * A synthetic org created straight in SQL has no trial date, and
   * `createTestStore` makes one for most of this suite. If a missing date
   * derived as "expired", every storefront fixture in the repo would go dark —
   * so this pins the safety valve that keeps the other ~60 tests honest.
   */
  it("does not hold an org that has no trial date recorded", async () => {
    const other = new Cleanup();
    try {
      const store = await createTestStore(other, "ungated");
      const page = await fetch(`${BASE_URL}/_sites/${store.site.slug}/`);
      expect(page.status).toBe(200);
    } finally {
      await other.run();
    }
  });
});
