import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Receipts send without a verified sending domain (D44).
 *
 * **What only this can show.** `tenantFallbackSender` is unit-tested, but the
 * change D44 actually made was two pieces of *wiring*: dropping the `auth_*`
 * template restriction inside `sendMerchantMail`, and resolving the storefront
 * from `orderId` when the caller does not pass `siteId`. `orders.resendConfirmation`
 * exercises both at once — it sends a non-auth template and passes only an
 * order id — and neither is visible from a unit test.
 *
 * Gated, because it sends a **real message through SES** and needs the fallback
 * to exist at all:
 *
 * ```bash
 * ROOT_DOMAIN=markii.shop DEMO_SKIP_PAYMENT_VERIFICATION=1 pnpm dev
 *
 * MARKII_SES_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *   vitest run --project integration merchant-mail-fallback
 * ```
 *
 * On `ROOT_DOMAIN=localhost` — how the normal suite runs — `tenantFallbackSender`
 * returns null by design, so there is no fallback and this would assert the
 * opposite of what it means to. It refuses to run rather than passing vacuously.
 *
 * Mail goes to the SES simulator, which touches neither reputation nor quota.
 */
const ENABLED = process.env.MARKII_SES_TESTS === "1";
const ROOT = process.env.ROOT_DOMAIN;

const describeMaybe = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    "\n  merchant-mail-fallback: SKIPPED. Set MARKII_SES_TESTS=1 with a dev server on a real\n" +
      "  ROOT_DOMAIN to prove receipts send without a verified sending domain (D44).\n",
  );
}

describeMaybe("merchant mail — fallback sender (D44)", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: { id: number; slug: string; name: string };
  let orderId: number;
  const buyer = `success+receipt${Date.now()}@simulator.amazonses.com`;

  beforeAll(async () => {
    if (!ROOT || ROOT === "localhost" || ROOT.endsWith(".localhost")) {
      throw new Error(
        `ROOT_DOMAIN is "${ROOT}". The dev server must run with a real root domain or there is ` +
          "no fallback sender, and this suite would pass without testing anything.",
      );
    }

    const { email } = await signUpMerchant(merchant, "mailfallback");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "mailfallback", { orgId });
    site = store.site as typeof site;

    /**
     * Written directly rather than driven through checkout: this is about who
     * the mail comes *from*, and a full purchase would add several unrelated
     * ways to fail.
     */
    // No `org_id` on orders — ownership is reached through the site, which is
    // the single tenancy path the schema deliberately keeps.
    const [order] = await sql`
      insert into orders (site_id, email, status, provider, currency, amount_cents,
                          subtotal_minor, financial_status)
      values (${site.id}, ${buyer}, 'success', 'x402', 'USD', 1400, 1400, 'paid')
      returning id`;
    orderId = order.id as number;
    cleanup.orderIds.push(orderId);
  }, 180_000);

  afterAll(async () => {
    await sql`delete from email_deliveries where to_email = ${buyer}`.catch(() => {});
    await cleanup.run();
  }, 120_000);

  it("has no verified sending domain — the state this is all about", async () => {
    // The precondition. Without asserting it, a merchant who somehow had a
    // verified domain would make the next test pass for the wrong reason.
    const identities = await sql`select id from email_identities where org_id = ${orgId}`;
    expect(identities.length).toBe(0);

    const settings = await merchant.get("/api/settings/email");
    expect(settings.status).toBe(200);
    /** D44: sending, not refusing — `canSend` is true in this state now. */
    expect(settings.json.customerEmail.code).toBe("unverified_sender");
    expect(settings.json.customerEmail.canSend).toBe(true);
  }, 60_000);

  it("sends a receipt from the storefront's address", async () => {
    const res = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.queued).toBe(true);

    /**
     * The send is a post-commit effect, so the row appears just after the
     * response. Polled rather than slept on — a fixed sleep is either flaky or
     * slow, and usually both.
     */
    let row: { template: string; provider: string; status: string; reason: string | null } | undefined;
    for (let i = 0; i < 20; i++) {
      const rows = await sql`
        select template, provider, status, reason from email_deliveries
        where to_email = ${buyer} order by created_at desc limit 1`;
      row = rows[0] as typeof row;
      if (row) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(row, "no delivery was recorded at all").toBeDefined();
    expect(row!.template).toBe("order_confirmation");
    /**
     * The two facts D44 turns on: a **non-auth** template was allowed to use the
     * fallback, and the storefront was found from the order alone. Before the
     * change this row read `not_configured` / `none`.
     */
    expect(row!.status, row!.reason ?? "").toBe("sent");
    expect(row!.provider).toBe("ses");
  }, 120_000);

  it("still nags the merchant to verify their own domain", async () => {
    /**
     * The fallback is a floor, not a destination. If readiness went quiet the
     * moment mail started working, every merchant would stay on Markii's shared
     * sending reputation forever.
     */
    // `/overview` returns the score and its components; the findings themselves
    // are `/issues`. Reading `issues` off the overview silently yields [] and
    // makes this pass for nothing.
    const res = await merchant.get(`/api/readiness/issues?siteId=${site.id}`);
    expect(res.status).toBe(200);
    const codes = (res.json.items ?? []).map((i: { code: string }) => i.code);
    expect(codes, JSON.stringify(codes)).toContain("UNVERIFIED_SENDING_DOMAIN");
  }, 60_000);
});
