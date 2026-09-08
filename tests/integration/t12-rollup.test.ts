import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The §4.5 trailing-twelve rollup end to end (`docs/PRICING.md`).
 *
 * The arithmetic is the same aggregate the meter already ran, so summing is not
 * what is worth testing. What only a real run can show is the **safety
 * property**: that this is a cache which cannot report a wrong number. Three
 * things carry that, and each is asserted here —
 *
 * 1. a fresh rollup is used, and the meter says so with `t12AsOf`;
 * 2. a **stale** rollup is ignored, and the live sum answers instead — so a cron
 *    that stops running costs a query rather than correctness;
 * 3. a rollup that disagrees with the ledger is **reported** by the drift check
 *    rather than silently trusted or silently repaired.
 */
describe("t12 rollup", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: any;

  const secret = process.env.CRON_SECRET;

  const runRollupJob = () =>
    fetch(`${BASE_URL}/api/cron/t12-rollup`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  const meter = () => merchant.get("/api/billing/usage");
  const rows = () =>
    sql`select * from t12_net_sales where org_id = ${orgId} order by product_class nulls last`;

  /** Inside the trailing year, comfortably clear of its edges. */
  const inWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  async function seedUsage(amountMinor: number, productClass: "physical" | "digital") {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await sql`insert into usage_records
      (id, org_id, site_id, order_id, type, product_class, amount_minor, currency,
       converted_minor, occurred_at, environment, dedupe_key)
      values (${`ur_t12_${stamp}`}, ${orgId}, ${site.id}, null, 'sale',
       ${productClass}, ${amountMinor}, 'USD', ${amountMinor}, ${inWindow}, 'production',
       ${`sale:t12:${stamp}`})`;
  }

  beforeAll(async () => {
    if (!secret) {
      throw new Error("CRON_SECRET is not set in this test process; the rollup job is gated on it.");
    }
    const { email } = await signUpMerchant(merchant, "t12");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    site = (await createTestStore(cleanup, "t12", { orgId })).site;

    await seedUsage(120_00, "physical");
    await seedUsage(80_00, "digital");
  }, 180_000);

  afterAll(async () => {
    await sql`delete from t12_net_sales where org_id = ${orgId}`;
    await sql`delete from usage_records where org_id = ${orgId}`;
    await cleanup.run();
  }, 120_000);

  describe("authentication", () => {
    it("refuses an unauthenticated request", async () => {
      const res = await fetch(`${BASE_URL}/api/cron/t12-rollup`);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("refuses a wrong secret without naming the variable", async () => {
      const res = await fetch(`${BASE_URL}/api/cron/t12-rollup`, {
        headers: { authorization: "Bearer not-the-secret" },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await res.json().catch(() => ({})))).not.toMatch(/CRON_SECRET=/);
    });
  });

  it("writes one row per fee class, and never merges them", async () => {
    const res = await runRollupJob();
    expect(res.status).toBe(200);

    const written = await rows();
    const byClass = Object.fromEntries(written.map((r: any) => [r.product_class, r]));
    /**
     * Physical and digital meter against **separate thresholds** (D39). One
     * combined row would put a merchant over a line neither class crossed.
     */
    expect(Number(byClass.physical.net_sales_minor)).toBe(120_00);
    expect(Number(byClass.digital.net_sales_minor)).toBe(80_00);
  });

  it("the meter uses a fresh rollup and says when it was computed", async () => {
    await runRollupJob();

    const res = await meter();
    expect(res.status).toBe(200);
    // Null would mean it summed live — correct, but not what a fresh cache means.
    expect(res.json.t12AsOf, "a fresh rollup should be used").toBeTruthy();
    expect(new Date(res.json.t12AsOf).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  /**
   * **The property that makes the cache safe to ship.** A cron that silently
   * stops must degrade to the exact query the meter used before this existed —
   * not to yesterday's number presented as today's.
   */
  it("ignores a stale rollup and falls back to the live sum", async () => {
    await runRollupJob();

    const fresh = await meter();
    const liveT12 = fresh.json.trailing12NetSalesMinor;
    expect(fresh.json.t12AsOf).toBeTruthy();

    // Older than MAX_ROLLUP_AGE_MS (26h), and wrong, so trusting it would show.
    await sql`update t12_net_sales
      set computed_at = now() - interval '3 days', net_sales_minor = 999999999
      where org_id = ${orgId}`;

    const stale = await meter();
    expect(stale.json.t12AsOf, "a stale rollup must not be used").toBeNull();
    expect(stale.json.trailing12NetSalesMinor).toBe(liveT12);
  });

  it("a rollup that disagrees with the ledger is reported, not trusted", async () => {
    await runRollupJob();
    await sql`update t12_net_sales set net_sales_minor = net_sales_minor + 500
      where org_id = ${orgId} and product_class = 'physical'`;

    const res = await fetch(`${BASE_URL}/api/cron/billing?orgId=${orgId}&dryRun=1`, {
      headers: { authorization: `Bearer ${secret}` },
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
    expect(res.status).toBe(200);

    const mine = (res.json.outcomes ?? []).find((o: any) => o.orgId === orgId);
    expect(mine, "the sweep should have considered this org").toBeTruthy();
    const physical = (mine.drift ?? []).find((d: any) => d.productClass === "physical");
    expect(physical, "the injected disagreement should be reported").toBeTruthy();
    expect(physical.differenceMinor).toBe(-500);

    /**
     * **Reported, never repaired.** Overwriting the row here would destroy the
     * evidence of which side is wrong; the next nightly run rewrites it anyway.
     */
    const after = await rows();
    const stillWrong = after.find((r: any) => r.product_class === "physical");
    expect(stillWrong).toBeTruthy();
    expect(Number(stillWrong!.net_sales_minor)).toBe(120_00 + 500);
  });

  it("drops rows for classes that have aged out of the window", async () => {
    await runRollupJob();
    expect((await rows()).some((r: any) => r.product_class === "digital")).toBe(true);

    // Move the digital sale outside the trailing year.
    await sql`update usage_records set occurred_at = now() - interval '400 days'
      where org_id = ${orgId} and product_class = 'digital'`;
    await runRollupJob();

    /**
     * The row must go, not go to zero-by-omission: leaving the old figure would
     * report revenue that has aged out of the window as current.
     */
    expect((await rows()).some((r: any) => r.product_class === "digital")).toBe(false);
    const meterRes = await meter();
    expect(meterRes.json.t12AsOf).toBeTruthy();
  });
});
