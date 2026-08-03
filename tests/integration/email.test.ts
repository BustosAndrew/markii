import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Cleanup,
  Client,
  createTestStore,
  refused,
  signUpMerchant,
  sql,
  trackCart,
  trackOrderCascade,
} from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Merchant email (§6).
 *
 * AWS SES is not configured in this environment and will not be — so what these
 * tests can prove is the part that matters most: **that an email nobody sent is
 * never reported as sent**. The order timeline, the delivery log, and the
 * settings surface each have to say "not configured", and none of them may fall
 * back to Markii's own sending domain to make the failure go away (G1).
 *
 * The suppression list is exercised for real, because it is enforced entirely in
 * our own code and is what keeps one merchant's dead addresses from getting the
 * whole platform's SES account suspended.
 */
describe("email", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let slug: string;
  let site: any;
  let p1: any;
  let locationId: number;
  let orderId: number;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "email");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "email", { orgId });
    slug = store.slug;
    site = store.site;
    [p1] = store.products;

    const [loc] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Email Test Location', true) returning *`;
    locationId = loc.id;
    cleanup.locationIds.push(loc.id);

    const [v] = await sql`insert into variants (product_id, title, option_values, price_minor,
      weight_grams, requires_shipping, inventory_policy)
      values (${p1.id}, 'Mail', ${sql.json({ Mail: "one" })}, 2500, 100, false, 'deny') returning *`;
    cleanup.variantIds.push(v.id);
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type)
      values (${v.id}, ${locationId}, 20, 'test seed', 'system')`;

    // A real purchase with an address on it, so mail has somewhere to go.
    const c = await shopper.post(cart(), { productId: p1.id, variantId: v.id, quantity: 1 });
    await trackCart(cleanup, c.json.token);

    const session = await shopper.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
      email: "buyer@example.com",
    });
    if (session.status !== 201) {
      throw new Error(`checkout session failed: ${session.status} ${JSON.stringify(session.json)}`);
    }
    cleanup.checkoutSessionIds.push(session.json.id);
    const paid = await shopper.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: `0xmail${Date.now().toString(16)}`,
    });
    expect(paid.status).toBe(200);
    orderId = paid.json.orderId;
    await trackOrderCascade(cleanup, orderId);
  });

  afterAll(async () => {
    await sql`delete from email_deliveries where org_id = ${orgId}`;
    await sql`delete from email_suppressions where org_id = ${orgId}`;
    await sql`delete from email_identities where org_id = ${orgId}`;
    await cleanup.run();
  });

  // -------------------------------------------------------------------------
  // Honest state
  // -------------------------------------------------------------------------

  it("reports that customer email cannot be sent, and whose problem it is", async () => {
    const res = await merchant.get("/api/settings/email");
    expect(res.status).toBe(200);
    expect(res.json.customerEmail.canSend).toBe(false);
    // Two different problems with two different owners: no AWS credentials is
    // ours, no verified domain is theirs.
    expect(["configuration_required", "domain_verification_required"]).toContain(
      res.json.customerEmail.code,
    );
    expect(res.json.providerConfigured).toBe(false);
  });

  it("keeps the two email streams separate rather than reporting one status", async () => {
    const res = await merchant.get("/api/settings/email");
    // Merchant mail (SES, their domain) and platform mail (Resend, markii.shop)
    // are different systems. A merchant whose password reset arrived would
    // otherwise conclude their order confirmations work.
    expect(res.json.platformEmail).toBeDefined();
    expect(res.json.platformEmail.scope).toMatch(/Markii's own mail/i);
    expect(res.json.customerEmail).not.toEqual(res.json.platformEmail);
  });

  it("starts with no sending domains and no suppressions", async () => {
    const res = await merchant.get("/api/settings/email");
    expect(res.json.domains).toEqual([]);
    expect(res.json.suppressions).toEqual([]);
  });

  it("refuses to register a sending domain rather than writing an unusable row", async () => {
    // Without SES there are no DKIM tokens, so a row here would show the
    // merchant a verification step with no records to publish.
    const res = await merchant.invoke("email.addSendingDomain", { domain: "acme-test.example" });
    expect(refused(res)).toBe(true);

    const rows = await sql`select * from email_identities where org_id = ${orgId}`;
    expect(rows).toHaveLength(0);
  });

  it("rejects a malformed domain with a message, not a database error", async () => {
    const res = await merchant.invoke("email.addSendingDomain", { domain: "not a domain" });
    expect(refused(res)).toBe(true);
    expect(JSON.stringify(res.json)).toMatch(/domain/i);
  });

  // -------------------------------------------------------------------------
  // Sending: recorded, never claimed
  // -------------------------------------------------------------------------

  it("records an unsent confirmation as not_configured, never as sent", async () => {
    const res = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(res.json.ok).toBe(true);
    // The action reports it queued. Whether it *sent* is a separate fact.
    expect(res.json.result.queued).toBe(true);

    const [row] = await sql`select * from email_deliveries
      where org_id = ${orgId} and order_id = ${orderId}
      order by created_at desc limit 1`;
    expect(row).toBeTruthy();
    expect(row.status).toBe("not_configured");
    expect(row.provider).toBe("none");
    expect(row.provider_message_id).toBeNull();
    expect(row.template).toBe("order_confirmation");
    expect(row.reason).toMatch(/not configured|SES/i);
  });

  it("tells the merchant on the order timeline that the email did not go out", async () => {
    const detail = await merchant.get(`/api/orders/${orderId}`);
    const mailEvents = (detail.json.timeline ?? []).filter((e: any) =>
      e.type?.startsWith("email_"),
    );
    expect(mailEvents.length).toBeGreaterThan(0);
    // A success entry here would be the exact failure `CLAUDE.md` forbids: a
    // merchant believing their customer was contacted.
    expect(mailEvents.every((e: any) => e.type === "email_failed")).toBe(true);
  });

  it("never falls back to Markii's own sending domain", async () => {
    const rows = await sql`select * from email_deliveries where org_id = ${orgId}`;
    // Resend is configured for platform mail in some environments. Merchant
    // mail must not borrow it — that is what puts a merchant's bounces on
    // Markii's reputation (G1).
    expect(rows.every((r: any) => r.provider !== "resend")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Suppression
  // -------------------------------------------------------------------------

  it("suppresses an address and blocks it before anything else is attempted", async () => {
    const add = await merchant.invoke("email.suppressAddress", {
      email: "Buyer@Example.com",
      note: "asked us to stop",
    });
    expect(add.json.ok).toBe(true);
    // Lowercased, or the list is trivially walked past.
    expect(add.json.result.email).toBe("buyer@example.com");

    const resend = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(resend.json.ok).toBe(true);

    const [row] = await sql`select * from email_deliveries
      where org_id = ${orgId} and order_id = ${orderId}
      order by created_at desc limit 1`;
    // Suppression is checked first, so this says `suppressed` rather than
    // `not_configured` — proving the check runs before the transport.
    expect(row.status).toBe("suppressed");
  });

  it("shows the suppression to the merchant and marks it removable", async () => {
    const res = await merchant.get("/api/settings/email");
    const entry = res.json.suppressions.find((s: any) => s.email === "buyer@example.com");
    expect(entry).toBeTruthy();
    expect(entry.reason).toBe("manual");
    expect(entry.removable).toBe(true);
  });

  it("lets a merchant undo their own suppression", async () => {
    const res = await merchant.invoke("email.unsuppressAddress", { email: "buyer@example.com" });
    expect(res.json.ok).toBe(true);
    expect(res.json.result.removed).toBe(true);

    const rows = await sql`select * from email_suppressions
      where org_id = ${orgId} and email = 'buyer@example.com'`;
    expect(rows).toHaveLength(0);
  });

  it("refuses to re-enable an address that reported mail as spam", async () => {
    // Written directly because production code only records a complaint from a
    // verified SNS event — which is the point: the refusal is enforced here too.
    await sql`insert into email_suppressions (org_id, email, reason, detail)
      values (${orgId}, 'angry@example.com', 'complaint', 'abuse')`;

    const res = await merchant.invoke("email.unsuppressAddress", { email: "angry@example.com" });
    expect(refused(res)).toBe(true);
    expect(JSON.stringify(res.json)).toMatch(/spam|policy/i);

    // And it really is still suppressed.
    const rows = await sql`select * from email_suppressions
      where org_id = ${orgId} and email = 'angry@example.com'`;
    expect(rows).toHaveLength(1);
  });

  it("does not let a manual entry downgrade a recorded complaint", async () => {
    await merchant.invoke("email.suppressAddress", { email: "angry@example.com" });
    const [row] = await sql`select * from email_suppressions
      where org_id = ${orgId} and email = 'angry@example.com'`;
    // Otherwise a merchant could clear a complaint in two clicks: suppress
    // manually, then unsuppress.
    expect(row.reason).toBe("complaint");
  });

  it("scopes suppression to one organization", async () => {
    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "email-outsider");
    cleanup.merchantEmails.push(email);

    const theirs = await outsider.get("/api/settings/email");
    // An address that complained about this store has not blocked every store.
    expect(theirs.json.suppressions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The bounce webhook
  // -------------------------------------------------------------------------

  it("rejects an unsigned SNS message rather than trusting it", async () => {
    // An unverified webhook is a remote suppression button: fabricated
    // complaints would silently stop a merchant mailing their own customers.
    const res = await fetch(`${BASE_URL}/api/webhooks/ses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Type: "Notification",
        MessageId: "forged",
        TopicArn: "arn:aws:sns:us-east-1:1:x",
        Message: JSON.stringify({
          eventType: "Complaint",
          mail: { messageId: "whatever" },
          complaint: { complainedRecipients: [{ emailAddress: "victim@example.com" }] },
        }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: "1",
        Signature: "not-a-signature",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
      }),
    });
    expect(res.status).toBe(403);

    const rows = await sql`select * from email_suppressions where email = 'victim@example.com'`;
    expect(rows).toHaveLength(0);
  });

  it("rejects a certificate URL that is not an AWS SNS host", async () => {
    const res = await fetch(`${BASE_URL}/api/webhooks/ses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Type: "Notification",
        MessageId: "forged-2",
        TopicArn: "arn:aws:sns:us-east-1:1:x",
        Message: "{}",
        Timestamp: new Date().toISOString(),
        SignatureVersion: "1",
        Signature: "x",
        // Would pass a naive `endsWith` check, and hands us our own trust anchor.
        SigningCertURL: "https://sns.us-east-1.amazonaws.com.attacker.net/cert.pem",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await fetch(`${BASE_URL}/api/webhooks/ses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it("does not expose another org's sending domains", async () => {
    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "email-outsider2");
    cleanup.merchantEmails.push(email);

    await sql`insert into email_identities (org_id, domain, from_local_part, status, dkim_tokens)
      values (${orgId}, 'scoped-test.example', 'orders', 'pending', ${sql.json([])})`;

    const theirs = await outsider.get("/api/settings/email");
    expect(theirs.json.domains).toEqual([]);

    const mine = await merchant.get("/api/settings/email");
    expect(mine.json.domains.map((d: any) => d.domain)).toContain("scoped-test.example");
  });

  it("refuses to verify a sending domain belonging to another org", async () => {
    const [row] = await sql`select id from email_identities
      where org_id = ${orgId} and domain = 'scoped-test.example'`;

    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "email-outsider3");
    cleanup.merchantEmails.push(email);

    const res = await outsider.invoke("email.verifySendingDomain", { identityId: row.id });
    expect(refused(res)).toBe(true);
  });
});
