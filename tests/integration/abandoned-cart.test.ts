import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Abandoned-cart recovery, end to end (§24, D27).
 *
 * **What only this can show.** The selection predicate is verifiable against
 * fixtures and the copy is unit-tested, but the parts that decide whether this
 * feature is safe are wiring: the opt-in gate actually gating, the claim
 * actually preventing a second send, and a real message reaching SES from the
 * storefront's address. None of that is visible from a unit test.
 *
 * Gated with the other SES suites — it sends a **real message** and needs a
 * fallback sender to exist at all:
 *
 * ```bash
 * ROOT_DOMAIN=markii.shop DEMO_SKIP_PAYMENT_VERIFICATION=1 pnpm dev
 *
 * MARKII_SES_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *   vitest run --project integration abandoned-cart
 * ```
 *
 * Mail goes to `simulator.amazonses.com`, which touches neither reputation nor
 * quota.
 */
const ENABLED = process.env.MARKII_SES_TESTS === "1";
const ROOT = process.env.ROOT_DOMAIN;
const CRON_SECRET = process.env.CRON_SECRET;

const describeMaybe = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.log(
    "\n  abandoned-cart: SKIPPED. Set MARKII_SES_TESTS=1 with a dev server on a real ROOT_DOMAIN\n" +
      "  to drive a recovery email through the hourly sweep.\n",
  );
}

/** The sweep runs behind `CRON_SECRET`, exactly as Vercel Cron invokes it. */
async function runSweep() {
  const res = await fetch(`${BASE_URL}/api/cron/abandoned-carts`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describeMaybe("abandoned-cart recovery sweep", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: { id: number; slug: string };
  let cartId: number;
  const shopper = `success+cart${Date.now()}@simulator.amazonses.com`;

  beforeAll(async () => {
    if (!ROOT || ROOT === "localhost" || ROOT.endsWith(".localhost")) {
      throw new Error(
        `ROOT_DOMAIN is "${ROOT}". Without a real root domain there is no sender, so the sweep ` +
          "would claim carts and send nothing — passing while proving the opposite.",
      );
    }
    if (!CRON_SECRET) throw new Error("CRON_SECRET is required — the sweep refuses without it.");

    const { email } = await signUpMerchant(merchant, "abandoned");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "abandoned", { orgId });
    site = store.site as typeof site;

    /**
     * A cart that went quiet two hours ago — past `QUIET_FOR_MS`, well inside
     * `STALE_AFTER_MS`. Written directly so the clock is controlled; driving it
     * through the storefront would leave `updated_at` at "now" and select
     * nothing.
     */
    const quietAt = new Date(Date.now() - 2 * 60 * 60_000);
    const [cart] = await sql`
      insert into carts (token, site_id, email, status, currency, expires_at, created_at, updated_at)
      values (${`tok_ab_${Date.now()}`}, ${site.id}, ${shopper}, 'open', 'USD',
              ${new Date(Date.now() + 14 * 864e5)}, ${quietAt}, ${quietAt})
      returning id`;
    cartId = cart.id as number;
    cleanup.cartIds.push(cartId);

    await sql`
      insert into cart_lines (cart_id, product_id, quantity, unit_price_minor_at_add)
      values (${cartId}, ${store.products[0].id}, 2, 1400)`;
  }, 180_000);

  afterAll(async () => {
    await sql`delete from email_deliveries where to_email = ${shopper}`.catch(() => {});
    await cleanup.run();
  }, 120_000);

  it("ignores the cart while the storefront has not opted in", async () => {
    /**
     * The gate that matters most. Everything else about this feature is a
     * quality question; sending on a merchant's behalf without being asked is a
     * consent one.
     */
    const before = await runSweep();
    expect(before.status).toBe(200);

    const [row] = await sql`select abandoned_mail_sent_at, status from carts where id = ${cartId}`;
    expect(row.abandoned_mail_sent_at, "an opted-out store must be untouched").toBeNull();
    expect(row.status).toBe("open");
  }, 120_000);

  it("refuses an unauthenticated sweep", async () => {
    // The endpoint mutates and sends mail behind a GET. Without the secret it
    // must not run at all.
    const res = await fetch(`${BASE_URL}/api/cron/abandoned-carts`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it("sends one recovery email once the merchant opts in", async () => {
    const patched = await merchant.patch(`/api/sites/${site.id}`, { abandonedCartEmails: true });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    expect(patched.json.abandonedCartEmails).toBe(true);

    const res = await runSweep();
    expect(res.status).toBe(200);
    expect(res.json.sent, JSON.stringify(res.json)).toBeGreaterThanOrEqual(1);

    const [delivery] = await sql`
      select template, provider, status, reason from email_deliveries
      where to_email = ${shopper} order by created_at desc limit 1`;
    expect(delivery, "no delivery recorded").toBeDefined();
    expect(delivery.template).toBe("abandoned_cart");
    expect(delivery.status, delivery.reason ?? "").toBe("sent");
    /** From the storefront's own address (D44) — this org has no verified domain. */
    expect(delivery.provider).toBe("ses");

    const [cart] = await sql`select abandoned_mail_sent_at, status from carts where id = ${cartId}`;
    expect(cart.abandoned_mail_sent_at).not.toBeNull();
    // Claimed *and* reclassified, so the cart stops looking open in reporting.
    expect(cart.status).toBe("abandoned");
  }, 180_000);

  it("never sends a second reminder for the same cart", async () => {
    /**
     * The promise the email itself makes — "this is the only reminder we will
     * send". The sweep runs hourly against a time window, so without the claim
     * this shopper would be mailed every hour for a day.
     */
    const before = await sql`select count(*)::int as n from email_deliveries where to_email = ${shopper}`;

    const again = await runSweep();
    expect(again.status).toBe(200);

    const after = await sql`select count(*)::int as n from email_deliveries where to_email = ${shopper}`;
    expect(after[0].n, "a second sweep must not mail again").toBe(before[0].n);
  }, 180_000);
});
