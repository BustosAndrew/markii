import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@/lib/auth/provisioning";
import { sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The two halves of D45 that only a real third party can prove.
 *
 * Everything else about the free trial is covered by `free-trial.test.ts` and
 * `membership-renewal.test.ts`, which drive real HTTP and synthetic *signed*
 * Stripe events. Two things stop at that boundary and were shipped unproven:
 *
 * 1. **`pause_collection` against Stripe.** The renewal tests prove the gate
 *    *decides* correctly; they never prove Stripe accepts the call, and the code
 *    was written from the API docs alone. A wrong parameter here fails silently
 *    in the direction that charges shoppers.
 * 2. **The reminder mail actually leaving.** Every scheduled run so far found
 *    zero candidates, so the query, the template and the Resend transport had
 *    never executed together.
 *
 * Both are opt-in, and both use the provider's own sandbox rather than a live
 * merchant: test-mode Stripe on the platform's own connected account, and
 * Resend's `delivered@resend.dev`, which is the counterpart of the SES
 * simulator address the suppression suite already uses.
 */

const STRIPE_ENABLED = process.env.MARKII_STRIPE_TESTS === "1";
const RESEND_ENABLED = process.env.MARKII_RESEND_TESTS === "1";

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
/** The platform's own test-mode connected account, as `membership-renewal` uses. */
const ACCOUNT = "acct_1U1bvmPA7TTkFIxl";

/** A Connect call shaped exactly like `lib/commerce/membership-billing.ts` makes. */
async function stripe(path: string, init: { method?: string; body?: URLSearchParams } = {}) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${KEY}`,
      "Stripe-Account": ACCOUNT,
      ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.body?.toString(),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json;
}

describe.skipIf(!STRIPE_ENABLED || !KEY.startsWith("sk_test"))(
  "pausing a member's billing against real Stripe",
  () => {
    let productId: string;
    let priceId: string;
    let customerId: string;
    let subscriptionId: string;

    beforeAll(async () => {
      const stamp = Date.now();
      const product = await stripe("/products", {
        method: "POST",
        body: new URLSearchParams({ name: `Markii hold test ${stamp}` }),
      });
      productId = product.id;

      const price = await stripe("/prices", {
        method: "POST",
        body: new URLSearchParams({
          product: productId,
          unit_amount: "1500",
          currency: "usd",
          "recurring[interval]": "month",
        }),
      });
      priceId = price.id;

      const customer = await stripe("/customers", {
        method: "POST",
        body: new URLSearchParams({ name: `Markii hold test ${stamp}` }),
      });
      customerId = customer.id;

      /**
       * A trial rather than an immediate charge: this needs a subscription in a
       * *billing* state to pause, and no card exists here. Nothing is ever
       * charged in either case — the trial simply avoids an `incomplete` that
       * Stripe would treat differently.
       */
      const sub = await stripe("/subscriptions", {
        method: "POST",
        body: new URLSearchParams({
          customer: customerId,
          "items[0][price]": priceId,
          trial_period_days: "30",
        }),
      });
      subscriptionId = sub.id;
    }, 60_000);

    afterAll(async () => {
      if (subscriptionId) await stripe(`/subscriptions/${subscriptionId}`, { method: "DELETE" }).catch(() => {});
      if (customerId) await stripe(`/customers/${customerId}`, { method: "DELETE" }).catch(() => {});
      if (priceId)
        await stripe(`/prices/${priceId}`, {
          method: "POST",
          body: new URLSearchParams({ active: "false" }),
        }).catch(() => {});
      if (productId)
        await stripe(`/products/${productId}`, {
          method: "POST",
          body: new URLSearchParams({ active: "false" }),
        }).catch(() => {});
    }, 60_000);

    it("sets pause_collection to void, so no invoice is ever charged", async () => {
      const { pauseMembershipCollection } = await import("@/lib/commerce/membership-billing");
      const res = await pauseMembershipCollection(ACCOUNT, subscriptionId);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.alreadyPaused).toBe(false);

      /**
       * Read back from Stripe rather than trusting the call's own answer —
       * asserting against the response that made the change proves only that the
       * function returned.
       *
       * **`void`, not `keep_as_draft`**: drafts accumulate and would hand a
       * returning merchant's members several back-dated invoices at once.
       */
      const sub = await stripe(`/subscriptions/${subscriptionId}`);
      expect(sub.pause_collection?.behavior).toBe("void");

      /** And the subscription still exists — paused, never cancelled. */
      expect(sub.status).not.toBe("canceled");
    }, 60_000);

    it("is idempotent, because Stripe raises invoice.created every month", async () => {
      const { pauseMembershipCollection } = await import("@/lib/commerce/membership-billing");
      const res = await pauseMembershipCollection(ACCOUNT, subscriptionId);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.alreadyPaused).toBe(true);
    }, 60_000);

    it("lifts the pause when the store comes back", async () => {
      const { resumeMembershipCollection } = await import("@/lib/commerce/membership-billing");
      const res = await resumeMembershipCollection(ACCOUNT, subscriptionId);
      expect(res.ok).toBe(true);
      /** It was genuinely paused, so this is a real change rather than a no-op. */
      if (res.ok) expect(res.alreadyActive).toBe(false);

      const sub = await stripe(`/subscriptions/${subscriptionId}`);
      /**
       * The half that matters most: a pause that cannot be lifted is worse than
       * no pause at all — the merchant pays and their members never bill again.
       */
      expect(sub.pause_collection).toBeNull();
      expect(sub.status).not.toBe("canceled");
    }, 60_000);

    /**
     * Speculative resume is now called on **every** `invoice.created` for a
     * healthy store, so it has to be free when there is nothing to lift — a
     * blind write would mutate a merchant's subscription every billing cycle.
     */
    it("is a no-op when nothing is paused, so it is safe to call speculatively", async () => {
      const { resumeMembershipCollection } = await import("@/lib/commerce/membership-billing");
      const res = await resumeMembershipCollection(ACCOUNT, subscriptionId);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.alreadyActive).toBe(true);
    }, 60_000);
  },
);

describe.skipIf(!RESEND_ENABLED)("the trial reminder actually sending", () => {
  const orgId = newId("org");
  const slug = `trial-mail-${Date.now()}`;

  beforeAll(async () => {
    /**
     * Two days out, so it lands inside `WARN_WITHIN_MS` (three days) — and no
     * subscription, so `notGranting()` selects it.
     *
     * `delivered@resend.dev` is Resend's sandbox address: it accepts and reports
     * delivery without touching a real inbox or the sending reputation, the same
     * role `success@simulator.amazonses.com` plays for SES.
     */
    await sql`insert into organizations
      (id, name, slug, owner_id, billing_email, currency, country, free_trial_ends_at)
      values (${orgId}, 'Trial Mail Test', ${slug}, ${`owner-${slug}`},
              'delivered@resend.dev', 'USD', 'US', now() + interval '2 days')`;
  });

  afterAll(async () => {
    await sql`delete from organizations where id = ${orgId}`;
  });

  it("selects the org, renders the mail, and Resend accepts it", async () => {
    const res = await fetch(`${BASE_URL}/api/cron/trial-reminders`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    /** Asserted on this org, not on the global count, so other data cannot skew it. */
    expect(body.sent).toBeGreaterThanOrEqual(1);
    expect(body.problems).toEqual([]);

    const [org] = await sql`select trial_reminder_sent_at from organizations where id = ${orgId}`;
    expect(org.trial_reminder_sent_at).not.toBeNull();
  }, 120_000);

  it("never mails the same org twice", async () => {
    /**
     * The claim is taken *before* the send precisely so a second run finds
     * nothing. Without it the daily job would mail every org in the three-day
     * window on all three days.
     */
    const before = await sql`select trial_reminder_sent_at from organizations where id = ${orgId}`;

    const res = await fetch(`${BASE_URL}/api/cron/trial-reminders`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
    expect(res.status).toBe(200);

    const after = await sql`select trial_reminder_sent_at from organizations where id = ${orgId}`;
    expect(after[0].trial_reminder_sent_at.toISOString()).toBe(
      before[0].trial_reminder_sent_at.toISOString(),
    );
  }, 120_000);
});
