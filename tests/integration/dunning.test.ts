import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The dunning ladder (D10) end to end.
 *
 * The ladder is derived from `past_due_since` and the clock, so the episode is
 * aged by rewriting that one column — the same way the trial tests move
 * `free_trial_ends_at` — and each rung is asserted through the surfaces it
 * actually holds: a REST write, a registry action, a storefront page, a cart.
 * The *transition into* dunning is driven by a synthetic, signed
 * `customer.subscription.updated` on the platform endpoint, because that is
 * the only writer of `past_due_since` and a redelivery must not restart it.
 */

const PLATFORM_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
/** The notice test sends real mail through Resend, so it is opt-in like the trial reminder's. */
const RESEND_ENABLED = process.env.MARKII_RESEND_TESTS === "1";
const DAY = 24 * 60 * 60_000;

describe.skipIf(!PLATFORM_SECRET)("dunning ladder", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let slug: string;
  let siteId: number;
  const subscriptionId = `sub_dun_${Date.now()}`;
  const customerId = `cus_dun_${Date.now()}`;

  async function subscriptionEvent(status: string) {
    const body = JSON.stringify({
      id: `evt_dun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      data: {
        object: {
          id: subscriptionId,
          object: "subscription",
          customer: customerId,
          status,
          cancel_at_period_end: false,
          trial_end: null,
          items: {
            data: [
              {
                id: "si_dun",
                current_period_start: Math.floor(Date.now() / 1000) - 86_400,
                current_period_end: Math.floor(Date.now() / 1000) + 86_400 * 29,
                price: { id: "price_dun", lookup_key: "markii_growth_month", recurring: { interval: "month" } },
              },
            ],
          },
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", PLATFORM_SECRET).update(`${ts}.${body}`, "utf8").digest("hex");
    const res = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${v1}` },
      body,
    });
    return res.status;
  }

  const age = (days: number) =>
    sql`update organizations set past_due_since = ${new Date(Date.now() - days * DAY)} where id = ${orgId}`;
  const standing = async () => (await merchant.get("/api/me")).json.standing;
  const pastDueSince = async () =>
    (await sql`select past_due_since from organizations where id = ${orgId}`)[0].past_due_since;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "dunning");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "dunning", { orgId });
    slug = store.slug;
    siteId = store.site.id;

    // A paying merchant, as the webhook would have left them.
    await sql`update organizations
      set stripe_subscription_id = ${subscriptionId}, stripe_customer_id = null,
          subscription_status = 'active', plan_id = 'growth'
      where id = ${orgId}`;
  });

  afterAll(async () => {
    await sql`delete from dunning_notices where org_id = ${orgId}`;
    await sql`delete from stripe_webhook_events where id like 'evt_dun_%'`;
    await cleanup.run();
  });

  it("starts the clock on the transition into past_due, and a redelivery does not restart it", async () => {
    expect(await pastDueSince()).toBeNull();
    expect(await subscriptionEvent("past_due")).toBe(200);
    const first = await pastDueSince();
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 1100));
    expect(await subscriptionEvent("past_due")).toBe(200);
    expect((await pastDueSince()).toISOString()).toBe(first.toISOString());

    const s = await standing();
    expect(s.state).toBe("past_due");
    expect(s.dunning.step).toBe("grace");
    expect(s.dunning.holds).toEqual({ growth: false, writes: false, storefront: false });
    expect(s.dunning.nextStep).toBe("restricted_growth");
  });

  it("holds nothing in the first week — growth and edits both go through", async () => {
    const edit = await merchant.patch(`/api/sites/${siteId}`, { name: "Still editable" });
    expect(edit.status).toBe(200);
    const token = await merchant.post("/api/org/tokens", { label: "grace", role: "viewer" });
    expect(token.status).toBe(201);
  });

  it("day 7: holds new storefronts and new tokens, keeps edits and the storefront", async () => {
    await age(8);
    expect((await standing()).dunning.step).toBe("restricted_growth");

    const token = await merchant.post("/api/org/tokens", { label: "held", role: "viewer" });
    expect(token.status).toBe(402);
    expect(token.json.error.code).toBe("PAYMENT_PAST_DUE");
    expect(token.json.error.details.dunningStep).toBe("restricted_growth");

    const site = await merchant.post("/api/sites", { name: "Second store during dunning" });
    expect(site.status).toBe(402);

    const edit = await merchant.patch(`/api/sites/${siteId}`, { name: "Edited on day 8" });
    expect(edit.status).toBe(200);

    const page = await shopper.getRaw(`/_sites/${slug}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Edited on day 8");
  });

  it("day 14: holds every write except billing, storefront still serves and sells", async () => {
    await age(15);
    expect((await standing()).dunning.step).toBe("restricted_writes");

    const edit = await merchant.patch(`/api/sites/${siteId}`, { name: "Edited on day 15" });
    expect(edit.status).toBe(402);
    expect(edit.json.error.code).toBe("PAYMENT_PAST_DUE");

    // A registry action is held the same way — one gate, every surface.
    const action = await merchant.post("/api/actions/catalog.setProductOptions", {
      productId: 1,
      options: [],
    });
    expect(action.status).toBe(402);
    expect(action.json.error.code).toBe("PAYMENT_PAST_DUE");

    // ...except billing, which is the only door out. The synthetic event above mirrored a
    // customer id that exists nowhere in Stripe; cleared so the address write stays local
    // (its Stripe half is covered by billing-address.test.ts).
    await sql`update organizations set stripe_customer_id = null where id = ${orgId}`;
    const billing = await merchant.post("/api/actions/billing.updateBillingAddress", {
      address: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    });
    expect(billing.status).toBe(200);

    const page = await shopper.getRaw(`/_sites/${slug}/`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("temporarily paused");
    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {});
    expect(cart.status).toBe(201);
  });

  /**
   * Stripe giving up is a later point on the same clock. The plan drops to the
   * floor (that is the mirror's rule), but standing stays on the ladder — the
   * storefront is not taken down on Stripe's schedule.
   */
  it("unpaid at day 20 is still the writes rung, not a dark store", async () => {
    await sql`update organizations set subscription_status = 'unpaid' where id = ${orgId}`;
    await age(20);
    const s = await standing();
    expect(s.state).toBe("past_due");
    expect(s.dunning.step).toBe("restricted_writes");
    const page = await shopper.getRaw(`/_sites/${slug}/`);
    expect(page.status).toBe(200);
    await sql`update organizations set subscription_status = 'past_due' where id = ${orgId}`;
  });

  it("day 30: the storefront stops serving and stops selling", async () => {
    await age(31);
    expect((await standing()).dunning.step).toBe("suspended");

    const page = await shopper.getRaw(`/_sites/${slug}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("temporarily paused");
    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {});
    expect(cart.status).toBe(409);
    const product = await shopper.getRaw(`/_sites/${slug}/p/test-product-one`);
    expect(product.status).toBe(404);
  });

  it("a paid invoice ends the episode: clock cleared, everything reinstated at once", async () => {
    expect(await subscriptionEvent("active")).toBe(200);
    expect(await pastDueSince()).toBeNull();
    expect((await standing()).state).toBe("subscribed");

    const edit = await merchant.patch(`/api/sites/${siteId}`, { name: "Back" });
    expect(edit.status).toBe(200);
    const page = await shopper.getRaw(`/_sites/${slug}/`);
    expect(page.text).not.toContain("temporarily paused");
  });

  it.skipIf(!RESEND_ENABLED)("sends each notice once per episode, from the daily cron", async () => {
    // A fresh episode, seven days in: the day-7 notice is due and day 0 is in the past.
    expect(await subscriptionEvent("past_due")).toBe(200);
    await age(7);

    const run = () =>
      fetch(`${BASE_URL}/api/cron/trial-reminders`, {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
      }).then((r) => r.json());

    const first = await run();
    expect(first.dunning.sent).toBeGreaterThanOrEqual(1);
    const rows = await sql`select step from dunning_notices where org_id = ${orgId} order by step`;
    expect(rows.map((r) => r.step)).toEqual([7]);

    const second = await run();
    const again = await sql`select step from dunning_notices where org_id = ${orgId}`;
    expect(again).toHaveLength(1);
    expect(second.dunning.failed).toBe(0);
  });
});
