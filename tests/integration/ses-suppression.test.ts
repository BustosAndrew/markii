import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * The bounce feedback loop, end to end (§24).
 *
 * **This is the last link in the email chain that had never carried a real
 * event.** Every hop was confirmed to *exist* — SES publishes to the config
 * set, the config set feeds `markii-ses-feedback`, the topic's subscription to
 * `/api/webhooks/ses` reads Confirmed — but nothing had ever travelled it, so
 * the suppression list had never actually suppressed anything.
 *
 * ```
 * send → SES → config set → SNS → /api/webhooks/ses → email_suppressions
 * ```
 *
 * **It works across machines on purpose.** The send happens from a local dev
 * server, but the delivery is recorded in the *shared* database, and SNS
 * delivers to the **deployed** webhook — which resolves the message id against
 * that same row. So this exercises the production receiver, not a local stub.
 * It follows that it only passes when the deployed app is current.
 *
 * ```bash
 * ROOT_DOMAIN=markii.shop DEMO_SKIP_PAYMENT_VERIFICATION=1 pnpm dev
 *
 * MARKII_SES_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *   vitest run --project integration ses-suppression
 * ```
 *
 * `bounce@simulator.amazonses.com` produces a **hard** bounce — the only kind
 * that suppresses (`Transient` is deliberately ignored: a full mailbox must not
 * silence a customer forever). Simulator mail touches neither the account's
 * reputation nor its quota, so this is safe to run repeatedly.
 */
const ENABLED = process.env.MARKII_SES_TESTS === "1";
const ROOT = process.env.ROOT_DOMAIN;

/** SES's hard-bounce simulator. Labelled so this run's mail is traceable. */
const BOUNCER = `bounce+markii${Date.now()}@simulator.amazonses.com`;

const describeMaybe = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    "\n  ses-suppression: SKIPPED. Set MARKII_SES_TESTS=1 with a dev server on a real ROOT_DOMAIN\n" +
      "  to drive a real bounce through SNS into the suppression list.\n",
  );
}

/** Polls, because SES → SNS → webhook is seconds and variable, not instant. */
async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

describeMaybe("SES bounce → SNS → suppression list", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let orderId: number;

  beforeAll(async () => {
    if (!ROOT || ROOT === "localhost" || ROOT.endsWith(".localhost")) {
      throw new Error(
        `ROOT_DOMAIN is "${ROOT}". Without a real root domain there is no sender at all, so ` +
          "nothing would be sent and nothing could bounce.",
      );
    }

    const { email } = await signUpMerchant(merchant, "suppression");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "suppression", { orgId });
    const [order] = await sql`
      insert into orders (site_id, email, status, provider, currency, amount_cents,
                          subtotal_minor, financial_status)
      values (${store.site.id}, ${BOUNCER}, 'success', 'x402', 'USD', 1400, 1400, 'paid')
      returning id`;
    orderId = order.id as number;
    cleanup.orderIds.push(orderId);
  }, 180_000);

  afterAll(async () => {
    // `email_suppressions.org_id` cascades from the organization, so dropping
    // the org takes the suppression with it.
    await sql`delete from email_deliveries where to_email = ${BOUNCER}`.catch(() => {});
    await cleanup.run();
  }, 120_000);

  it("sends the message and records a provider id to match the bounce against", async () => {
    /**
     * The provider message id is the whole hinge. Without it the webhook cannot
     * attribute the bounce to an org, and `email_deliveries_sent_has_id` exists
     * as a CHECK precisely so a `sent` row can never lack one.
     */
    const res = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const row = await waitFor("the delivery record", async () => {
      const rows = await sql`
        select status, provider_message_id, reason from email_deliveries
        where to_email = ${BOUNCER} order by created_at desc limit 1`;
      return rows[0];
    }, 60_000);

    expect(row.status, row.reason ?? "").toBe("sent");
    expect(row.provider_message_id).toBeTruthy();
  }, 180_000);

  it("suppresses the address once the bounce comes back through SNS", async () => {
    /**
     * The assertion this whole chain exists for. AWS suspends senders above
     * roughly 5% bounce — account-wide — so an address that keeps being retried
     * costs every merchant on the platform, not just this one.
     */
    const suppression = await waitFor("the suppression row", async () => {
      const rows = await sql`
        select reason, detail, source_message_id from email_suppressions
        where org_id = ${orgId} and email = ${BOUNCER.toLowerCase()} limit 1`;
      return rows[0];
    });

    expect(suppression.reason).toBe("bounce");
    /**
     * Traced back to the exact send rather than guessed from the address —
     * suppression is per org, and attributing a bounce to the wrong merchant
     * would silence mail to a customer who never complained about them.
     */
    expect(suppression.source_message_id).toBeTruthy();
  }, 180_000);

  it("marks the delivery bounced, so the order timeline tells the truth", async () => {
    const row = await waitFor("the delivery to be marked bounced", async () => {
      const rows = await sql`
        select status from email_deliveries
        where to_email = ${BOUNCER} order by created_at desc limit 1`;
      return rows[0]?.status === "bounced" ? rows[0] : undefined;
    });
    expect(row.status).toBe("bounced");
  }, 180_000);

  it("refuses to mail the address again", async () => {
    /**
     * Suppression that does not actually stop the next send is decoration. The
     * check runs *first* in `sendMerchantMail`, before sender resolution, for
     * exactly this reason.
     */
    const res = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(res.status).toBe(200);

    const row = await waitFor("the refused delivery", async () => {
      const rows = await sql`
        select status, reason from email_deliveries
        where to_email = ${BOUNCER} and status = 'suppressed' order by created_at desc limit 1`;
      return rows[0];
    }, 60_000);

    expect(row.status).toBe("suppressed");
    expect(row.reason).toMatch(/suppressed/i);
  }, 180_000);
});
