import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Recurring membership renewals (§18.9, D34).
 *
 * **Stripe is the scheduler, and that is the whole design.** Nothing in this
 * codebase runs jobs except the monthly billing sweep, so recurrence is only
 * possible because `invoice.paid` on the *Connect* endpoint arrives on its own
 * and extends `ends_at`. Membership status stays derived at read time; a
 * cancellation simply stops the extensions rather than revoking anything.
 *
 * **Driven by synthetic signed events rather than `stripe listen`, on purpose.**
 * The property most worth testing is that Stripe's three-day retry cannot grant
 * three periods for one payment — and asserting that needs *exact* control over
 * which invoice id arrives when, which a live delivery cannot give. The events
 * here are signed with the real `STRIPE_CONNECT_WEBHOOK_SECRET` and go through
 * the real route, so everything after the signature check is genuine.
 *
 * `stripe_webhook_events` dedupe does **not** cover this: a genuinely new
 * invoice must always extend, and a redelivery of an old one never must. That
 * distinction lives in `last_renewal_invoice_id`, and it is what these assert.
 */

const CONNECT_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? "";
const CONNECTED_ACCOUNT = "acct_1U1bvmPA7TTkFIxl";

const DAY = 86_400;

describe.skipIf(!CONNECT_SECRET)("recurring membership renewal", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let siteId: number;
  let tierId: number;
  let customerId: number;
  let membershipId: number;

  const subscriptionId = `sub_renew_${Date.now()}`;
  const eventIds: string[] = [];

  /** Signs and posts a Connect `invoice.paid` exactly as Stripe would. */
  async function invoicePaid(input: {
    invoiceId: string;
    periodStart: number;
    periodEnd: number;
    subtotal?: number;
    totalExcludingTax?: number | null;
    subscription?: string;
    eventId?: string;
  }) {
    const id = input.eventId ?? `evt_renew_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
    eventIds.push(id);

    const body = JSON.stringify({
      id,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      /**
       * False, matching the test-mode key. A live-mode event would be turned
       * away by the mode gate before reaching the handler — and it also decides
       * whether the renewal meters as `production` or `test`.
       */
      livemode: false,
      account: CONNECTED_ACCOUNT,
      data: {
        object: {
          id: input.invoiceId,
          currency: "usd",
          subtotal: input.subtotal ?? 20_00,
          total_excluding_tax:
            input.totalExcludingTax === undefined ? 20_00 : input.totalExcludingTax,
          amount_paid: 22_00,
          parent: {
            subscription_details: { subscription: input.subscription ?? subscriptionId },
          },
          lines: { data: [{ period: { start: input.periodStart, end: input.periodEnd } }] },
        },
      },
    });

    const ts = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", CONNECT_SECRET)
      .update(`${ts}.${body}`, "utf8")
      .digest("hex");

    const res = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${v1}` },
      body,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  const membership = async () => {
    const [row] = await sql`select * from customer_memberships where id = ${membershipId}`;
    return row;
  };

  const renewalUsage = async () =>
    sql`select * from usage_records where org_id = ${orgId} and dedupe_key like 'renewal:%'`;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "renewal");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "renewal", { orgId });
    siteId = store.site.id;

    const [tier] = await sql`insert into membership_tiers (site_id, name, handle)
      values (${siteId}, 'Renewal Test Tier', ${`renewal-${Date.now()}`}) returning *`;
    tierId = tier.id;

    const [cust] = await sql`insert into customers (site_id, email)
      values (${siteId}, ${`renew-${Date.now()}@markii.shop`}) returning *`;
    customerId = cust.id;

    /**
     * A membership one day from lapsing, already linked to the subscription —
     * the state a real second-period renewal arrives into.
     */
    const [row] = await sql`insert into customer_memberships
      (customer_id, tier_id, starts_at, ends_at, source, stripe_subscription_id)
      values (${customerId}, ${tierId}, now() - interval '30 days',
              now() + interval '1 day', 'purchase', ${subscriptionId})
      returning *`;
    membershipId = row.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of eventIds) {
      await sql`delete from stripe_webhook_events where id = ${id}`;
    }
    await sql`delete from usage_records where org_id = ${orgId}`;
    await sql`delete from customer_memberships where id = ${membershipId}`;
    await sql`delete from customers where id = ${customerId}`;
    await sql`delete from membership_tiers where id = ${tierId}`;
    await cleanup.run();
  }, 60_000);

  it("extends the membership by the period Stripe actually billed", async () => {
    const before = await membership();
    const now = Math.floor(Date.now() / 1000);

    const res = await invoicePaid({
      invoiceId: "in_renew_first",
      periodStart: now,
      periodEnd: now + 30 * DAY,
    });

    expect(res.status).toBe(200);
    expect(res.json.handled).toBe(true);

    const after = await membership();
    // Extended from the previous ends_at, not from today — a member who renews
    // early must not lose the days they already paid for.
    const gainedDays =
      (new Date(after.ends_at).getTime() - new Date(before.ends_at).getTime()) / 86_400_000;
    expect(Math.round(gainedDays)).toBe(30);
    expect(after.last_renewal_invoice_id).toBe("in_renew_first");
  });

  /**
   * **The reason `last_renewal_invoice_id` exists.** Stripe retries for three
   * days; without recognising a repeat, one payment buys three periods. The
   * `stripe_webhook_events` table cannot catch this — a redelivery carries the
   * same *event* id, but Stripe can also re-send the same invoice under a new
   * event id, and a genuinely new invoice must always extend.
   */
  it("does not extend twice for a redelivered invoice", async () => {
    const before = await membership();

    // A NEW event id carrying the SAME invoice — the case the webhook dedupe
    // table cannot see.
    const res = await invoicePaid({
      invoiceId: "in_renew_first",
      periodStart: Math.floor(Date.now() / 1000),
      periodEnd: Math.floor(Date.now() / 1000) + 30 * DAY,
    });

    expect(res.status).toBe(200);
    expect(res.json.handled).toBe(false);
    expect(res.json.reason).toMatch(/already extended/i);

    const after = await membership();
    expect(new Date(after.ends_at).getTime()).toBe(new Date(before.ends_at).getTime());
  });

  it("extends again for a genuinely new invoice", async () => {
    const before = await membership();
    const now = Math.floor(Date.now() / 1000);

    const res = await invoicePaid({
      invoiceId: "in_renew_second",
      periodStart: now,
      periodEnd: now + 30 * DAY,
    });

    expect(res.json.handled).toBe(true);
    const after = await membership();
    const gained =
      (new Date(after.ends_at).getTime() - new Date(before.ends_at).getTime()) / 86_400_000;
    expect(Math.round(gained)).toBe(30);
    expect(after.last_renewal_invoice_id).toBe("in_renew_second");
  });

  /**
   * Taking the money and leaving access revoked is the worse failure, so a
   * successful renewal reinstates — matching the one-off purchase path.
   */
  it("reinstates a revoked membership on a successful renewal", async () => {
    await sql`update customer_memberships set revoked_at = now() where id = ${membershipId}`;
    const now = Math.floor(Date.now() / 1000);

    await invoicePaid({
      invoiceId: "in_renew_after_revoke",
      periodStart: now,
      periodEnd: now + 30 * DAY,
    });

    const after = await membership();
    expect(after.revoked_at).toBeNull();
  });

  describe("metering", () => {
    /** Throws rather than returning undefined, so a missing row fails by name. */
    async function meteredRenewal(invoiceId: string) {
      const row = (await renewalUsage()).find(
        (r: any) => r.dedupe_key === `renewal:${invoiceId}`,
      );
      if (!row) throw new Error(`no usage record metered for ${invoiceId}`);
      return row;
    }

    it("meters the renewal with no order behind it, as digital", async () => {
      const row = await meteredRenewal("in_renew_second");

      // Stripe billed this on its own schedule — there is no order.
      expect(row.order_id).toBeNull();
      // A membership bills against the digital threshold at the digital rate (D39).
      expect(row.product_class).toBe("digital");
      expect(row.type).toBe("sale");
      // livemode:false, so it must never move a real threshold (§4.1).
      expect(row.environment).toBe("test");
    });

    it("meters net of tax, not the amount charged", async () => {
      const row = await meteredRenewal("in_renew_second");
      // subtotal 2000, total_excluding_tax 2000, amount_paid 2200. Metering the
      // 2200 would bill the merchant against tax they merely collected.
      expect(row.amount_minor).toBe(20_00);
    });

    it("writes one metering record per invoice, not per delivery", async () => {
      const rows = await renewalUsage();
      const first = rows.filter((r: any) => r.dedupe_key === "renewal:in_renew_first");
      // The redelivery above must not have doubled the merchant's usage.
      expect(first).toHaveLength(1);
    });
  });

  /**
   * A merchant's Stripe account carries every subscription they sell, including
   * ones Markii knows nothing about. That is not an error condition.
   */
  it("ignores an invoice for a subscription Markii does not know", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await invoicePaid({
      invoiceId: `in_unknown_${Date.now()}`,
      subscription: "sub_not_ours_at_all",
      periodStart: now,
      periodEnd: now + 30 * DAY,
    });

    expect(res.status).toBe(200);
    expect(res.json.handled).toBe(false);
    expect(res.json.reason).toMatch(/no membership/i);
  });

  it("ignores an invoice that is not for a subscription at all", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: `evt_nosub_${Date.now()}`,
      type: "invoice.paid",
      created: now,
      livemode: false,
      account: CONNECTED_ACCOUNT,
      data: { object: { id: "in_oneoff", currency: "usd", subtotal: 500 } },
    });
    eventIds.push(JSON.parse(body).id);

    const ts = now;
    const v1 = createHmac("sha256", CONNECT_SECRET).update(`${ts}.${body}`, "utf8").digest("hex");
    const res = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${v1}` },
      body,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).reason).toMatch(/not for a subscription/i);
  });
});
