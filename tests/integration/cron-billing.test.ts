import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The scheduled billing sweep (`docs/API.md` §25, D41).
 *
 * The arithmetic is unit-tested. What only a real request can show is the part
 * that carries the risk, and it is all wiring:
 *
 *  - that `CRON_SECRET` actually gates the endpoint, since a regression there is
 *    not a broken cron but an anonymous caller holding an actor with every
 *    permission on the platform;
 *  - that a `system` actor really does clear `assertStepUp` **over HTTP**. The
 *    sweep invokes `billing.invoiceAssessments`, which is `requiresStepUp`. If
 *    that waiver did not hold through a real request, every run would 403 and
 *    nobody would ever be billed — and no unit test constructing its own context
 *    object could see it;
 *  - that the org-selection queries find the right merchants at all.
 *
 * **Every run here is scoped with `?orgId=`.** An unscoped sweep closes periods
 * for every org in the database and can raise real Stripe items for any with a
 * live subscription. A test may not do that to data it does not own.
 */
describe("cron billing sweep", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: any;

  /**
   * The period the scheduler would close today — the month before this one, so
   * always finished by definition. The route derives the same window itself;
   * this only needs to know where to put the seeded sales.
   */
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  /** Mid-period, so an `occurredAt` here lands inside the window under test. */
  const midPeriod = new Date(periodStart.getTime() + 5 * 24 * 60 * 60 * 1000);

  const secret = process.env.CRON_SECRET;

  /** Raw fetch: this endpoint is bearer-authenticated and carries no session. */
  function sweep(
    query = "",
    token: string | null = secret ?? null,
  ): Promise<{ status: number; json: any }> {
    return fetch(`${BASE_URL}/api/cron/billing?orgId=${orgId}${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  }

  const assessments = () =>
    sql`select * from fee_assessments where org_id = ${orgId} order by product_class`;

  beforeAll(async () => {
    if (!secret) {
      throw new Error(
        "CRON_SECRET is not set in this test process. The sweep tests assert against a real " +
          "bearer check; without it they would only ever prove the 503 path.",
      );
    }

    const { email } = await signUpMerchant(merchant, "cron");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "cron", { orgId });
    site = store.site;
  });

  afterAll(async () => {
    await sql`delete from fee_assessments where org_id = ${orgId}`;
    await sql`delete from usage_records where org_id = ${orgId}`;
    await cleanup.run();
  });

  /**
   * A production sale inside the period under test, written straight to the
   * ledger rather than through a checkout.
   *
   * The checkout path is already covered by `billing.test.ts`; what this file
   * needs is money in a **finished** period, and a real checkout can only ever
   * write into the current one. `id` and `dedupe_key` are supplied because both
   * are required and unique — `dedupe_key` exists so a retried webhook cannot
   * double-meter a sale.
   */
  async function seedUsage(amountMinor: number, productClass: "physical" | "digital") {
    const key = `sale:cron-test:${productClass}:${Date.now()}`;
    const [row] = await sql`insert into usage_records
      (id, org_id, site_id, order_id, type, product_class, amount_minor, currency,
       converted_minor, occurred_at, environment, dedupe_key)
      values (${`ur_cron_${productClass}_${Date.now()}`}, ${orgId}, ${site.id}, null, 'sale',
       ${productClass}, ${amountMinor}, 'USD', ${amountMinor}, ${midPeriod}, 'production',
       ${key})
      returning *`;
    return row;
  }

  // ---- Authentication ----------------------------------------------------
  // These guard a permission bypass, not a feature.

  describe("authentication", () => {
    it("refuses an unauthenticated request", async () => {
      const res = await sweep("", null);
      expect(res.status).toBe(401);
    });

    it("refuses a wrong secret", async () => {
      const res = await sweep("", `${"z".repeat(40)}`);
      expect(res.status).toBe(401);
    });

    it("does not leak the variable name or its state to an anonymous caller", async () => {
      const res = await sweep("", null);
      // `errorResponse` runs sanitizePublicCopy, which redacts env var names.
      expect(JSON.stringify(res.json)).not.toMatch(/CRON_SECRET/);
    });

    it("refuses a secret sent without the Bearer scheme", async () => {
      const res = await fetch(`${BASE_URL}/api/cron/billing?orgId=${orgId}`, {
        headers: { authorization: secret! },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the configured secret", async () => {
      const res = await sweep("&dryRun=1");
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.scopedToOrgId).toBe(orgId);
    });
  });

  // ---- The sweep ---------------------------------------------------------

  describe("close and bill", () => {
    it("writes no assessment for an org with no usage in the period", async () => {
      const res = await sweep();

      expect(res.status).toBe(200);
      expect(res.json.orgsConsidered).toBe(0);
      expect(await assessments()).toHaveLength(0);
    });

    /**
     * Both amounts sit **above** the starter plan's $1,000 threshold on purpose.
     * Under it the fee is zero, and a zero fee is *settled* rather than skipped
     * — which would quietly test the opposite of the refusal asserted below.
     */
    it("closes a period from the usage ledger, per fee class", async () => {
      await seedUsage(2_500_00, "physical");
      await seedUsage(1_500_00, "digital");

      const res = await sweep();

      expect(res.status).toBe(200);
      expect(res.json.orgsClosed).toBe(1);

      const rows = await assessments();
      // Physical and digital run against separate thresholds at different
      // rates, so they are separate rows — never one blended assessment.
      expect(rows.map((r: any) => r.product_class)).toEqual(["digital", "physical"]);

      const byClass = (cls: string) => {
        const row = rows.find((r: any) => r.product_class === cls);
        if (!row) throw new Error(`no ${cls} assessment was written`);
        return row;
      };
      const physical = byClass("physical");
      const digital = byClass("digital");
      expect(Number(physical.period_net_sales_minor)).toBe(2_500_00);
      expect(Number(digital.period_net_sales_minor)).toBe(1_500_00);

      // $1,500 over the $1,000 threshold at 150bps, and $500 over at 300bps.
      // The rates differ by class, which is the whole reason they are separate
      // rows — a blended rate would be a number nobody is charged (D39).
      expect(Number(physical.fee_minor)).toBe(22_50);
      expect(Number(digital.fee_minor)).toBe(15_00);

      // Closing measures. It must never mark anything billed.
      for (const row of rows) expect(row.invoiced).toBe(false);
    });

    /**
     * **The assertion the whole design rests on.** The sweep reached
     * `billing.invoiceAssessments` — a `requiresStepUp` action — as a `system`
     * actor over HTTP and was not challenged. A 403 here would mean the cron
     * can never bill anyone.
     */
    it("is not challenged for step-up despite invoking a step-up action", async () => {
      const res = await sweep();

      expect(res.status).toBe(200);
      const outcome = res.json.outcomes.find((o: any) => o.orgId === orgId);
      expect(outcome.invoiced.ok).toBe(true);
      expect(JSON.stringify(res.json)).not.toMatch(/MFA_REQUIRED/);
    });

    /**
     * A merchant who never subscribed has nothing for an invoice item to ride
     * on, so nothing may be raised.
     *
     * Two guards in `assessmentBillable` cover this, and **the earlier one fires
     * here**: this org has no Stripe customer at all, which is refused before
     * the "no active subscription" check is reached. Both are real cases — an
     * org can have a customer from a cancelled subscription and still have
     * nothing to bill — so the assertion accepts either rather than pinning the
     * order the guards happen to run in.
     */
    it("refuses to bill an org with no billing relationship, and says why", async () => {
      const res = await sweep();

      const outcome = res.json.outcomes.find((o: any) => o.orgId === orgId);
      expect(outcome.invoiced.charging).toBe(false);
      expect(res.json.chargedByCurrency).toEqual({});
      expect(JSON.stringify(outcome.invoiced.skipped)).toMatch(
        /no Stripe customer|subscription|never be billed/i,
      );
      // Every unbilled assessment is accounted for by a stated reason — none
      // silently disappears from the run.
      expect(outcome.invoiced.skipped).toHaveLength((await assessments()).length);

      for (const row of await assessments()) {
        expect(row.invoiced).toBe(false);
        expect(row.stripe_invoice_item_id).toBeNull();
      }
    });

    it("does not assess the same period twice when run again", async () => {
      const before = await assessments();
      const res = await sweep();

      expect(res.json.orgsClosed).toBe(0); // nothing *newly* closed
      const after = await assessments();
      expect(after).toHaveLength(before.length);
      expect(after.map((r: any) => r.id).sort()).toEqual(before.map((r: any) => r.id).sort());
    });
  });

  // ---- Guards ------------------------------------------------------------

  describe("guards", () => {
    it("refuses to close a period that has not ended", async () => {
      // The current month, via the action directly — the route only ever offers
      // a finished period, so this is the guard's own test.
      const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const res = await merchant.post("/api/actions/billing.closePeriod", {
        periodStart: current.toISOString(),
      });

      expect(res.status).toBe(400);
      expect(res.json.error.message).toMatch(/has not ended|never during/i);
    });

    it("rejects an unreadable period parameter rather than defaulting", async () => {
      const res = await sweep("&period=not-a-date");
      expect(res.status).toBe(400);
    });

    it("writes nothing on a dry run", async () => {
      // A period with usage but deliberately never closed for real.
      await sql`delete from fee_assessments where org_id = ${orgId}`;

      const res = await sweep("&dryRun=1");

      expect(res.status).toBe(200);
      expect(res.json.dryRun).toBe(true);
      expect(await assessments()).toHaveLength(0);
    });

    it("stays inside the org it was scoped to", async () => {
      const res = await sweep();

      for (const outcome of res.json.outcomes) {
        expect(outcome.orgId).toBe(orgId);
      }
    });
  });
});
