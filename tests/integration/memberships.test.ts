import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Cleanup,
  Client,
  createTestStore,
  refused,
  signUpMerchant,
  sql,
  trackCart,
} from "./helpers";

/**
 * Membership gating (§18.9) and the shopper identity it rests on (§18.3).
 *
 * The point of these tests is the part a unit test cannot reach: that a gate
 * enforced in `lib/commerce/memberships.ts` actually refuses a real HTTP request
 * from a real un-entitled shopper, and that it stops refusing once they hold the
 * tier. Every assertion about what changed is made against the database rather
 * than by re-reading through the API that wrote it.
 */

const cleanup = new Cleanup();
const merchant = new Client();
/** Shopper identities this file created, removed in `afterAll`. */

let slug: string;
let siteId: number;
let orgId: string;
let tierId: number;
let gatedProductId: number;
let grantingProductId: number;
let openProductId: number;

/** A storefront shopper: separate client, so it carries its own cookie jar. */
function shopperClient() {
  return new Client();
}

/**
 * Sign a shopper in, creating them through Supabase's **admin** API first.
 *
 * The `/api/auth/sign-up` route is exercised on its own below. Going through it
 * for every shopper here sends a confirmation email each time, and the project's
 * hourly email cap then fails the suite for a reason that has nothing to do with
 * the code under test. `email_confirm: true` creates the account without mail.
 *
 * The **sign-in** still goes through the real storefront route, which is the
 * part these tests care about: it is what stamps the session cookie and links
 * the customer record.
 */
async function signUpShopper(client: Client, label: string, storeSlug = slug) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const email = `test-shopper-${label}-${stamp}@markii.shop`;
  const password = `Sh!${stamp}bB9`;

  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      // The authoritative marker (D32) — service-role only, exactly as the
      // sign-up route sets it.
      app_metadata: { user_kind: "customer" },
    }),
  });
  if (!res.ok) throw new Error(`admin create failed: ${await res.text()}`);
  // `auth.users` rows do not cascade from the site, so the suite owns removing
  // them; a leaked shopper would collide with nothing but would accumulate.
  cleanup.shopperEmails.push(email);

  client.clearCookies();
  const inRes = await client.post(`/_sites/${storeSlug}/api/auth/sign-in`, { email, password });
  if (inRes.status >= 400) throw new Error(`shopper sign-in failed: ${JSON.stringify(inRes.json)}`);

  return { email, password };
}

beforeAll(async () => {
  const m = await signUpMerchant(merchant, "memberships");
  cleanup.merchantEmails.push(m.email);
  orgId = (await merchant.get("/api/me")).json.org.id;

  const store = await createTestStore(cleanup, "memberships", { orgId });
  slug = store.slug;
  siteId = store.site.id;

  const tier = await merchant.post("/api/actions/memberships.createTier", {
    siteId,
    name: "Gold",
  });
  if (refused(tier)) throw new Error(`tier create failed: ${JSON.stringify(tier.json)}`);
  tierId = tier.json.result.id;

  // One product behind the gate, one that sells the tier, one open.
  gatedProductId = store.products[0].id;
  grantingProductId = store.products[1].id;
  openProductId = store.products[2].id;

  await sql`update products set requires_tier_id = ${tierId} where id = ${gatedProductId}`;
  await sql`update products set grants_tier_id = ${tierId}, grants_duration_days = 30
    where id = ${grantingProductId}`;
}, 120_000);

afterAll(async () => {
  // Shoppers are removed inside `cleanup.run()`, after the sites and customer
  // rows that reference them — and now in the same guarded sequence, so a
  // failure earlier in cleanup no longer skips them.
  await cleanup.run();
});

describe("membership gating", () => {
  it("refuses an anonymous shopper the gated product", async () => {
    const shopper = shopperClient();
    const res = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });

    expect(refused(res)).toBe(true);
    // The refusal must name the tier, or the shopper has no next step.
    expect(JSON.stringify(res.json)).toMatch(/Gold/i);
  });

  it("still sells the open product to an anonymous shopper", async () => {
    const shopper = shopperClient();
    const res = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: openProductId,
      quantity: 1,
    });

    expect(res.status).toBe(201);
    await trackCart(cleanup, res.json.token);
  });

  it("refuses a signed-in shopper who holds no membership", async () => {
    const shopper = shopperClient();
    await signUpShopper(shopper, "nomember");

    const res = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(refused(res)).toBe(true);
  });

  it("lets a member through, and refuses the same shopper once revoked", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "member");

    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;
    expect(customer, "sign-in should have created a customer record").toBeTruthy();

    const granted = await merchant.post("/api/actions/memberships.grant", {
      customerId: customer.id,
      tierId,
      durationDays: 30,
    });
    expect(refused(granted)).toBe(false);

    const allowed = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(allowed.status).toBe(201);
    await trackCart(cleanup, allowed.json.token);

    const revoked = await merchant.post("/api/actions/memberships.revoke", {
      customerId: customer.id,
      tierId,
    });
    expect(refused(revoked)).toBe(false);

    const denied = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(refused(denied), "revocation must take effect immediately").toBe(true);
  });

  it("expires by the clock, with no job having to run", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "expiring");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;

    await merchant.post("/api/actions/memberships.grant", {
      customerId: customer.id,
      tierId,
      durationDays: 30,
    });

    /**
     * Backdate the whole period. Both ends move because the
     * `customer_memberships_period_ordered` check refuses `ends_at <= starts_at`
     * — a membership that ends before it starts is never active, so the gate
     * would deny someone the merchant believes they granted.
     *
     * Nothing sweeps this table, so if status were stored rather than derived
     * the shopper would still be let in.
     */
    await sql`update customer_memberships
      set starts_at = now() - interval '40 days', ends_at = now() - interval '1 day'
      where customer_id = ${customer.id} and tier_id = ${tierId}`;

    const res = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(refused(res)).toBe(true);
  });

  it("refuses at checkout when a membership lapses after the cart was filled", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "lapse");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;

    await merchant.post("/api/actions/memberships.grant", {
      customerId: customer.id,
      tierId,
      durationDays: 30,
    });

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    await sql`update customer_memberships set revoked_at = now()
      where customer_id = ${customer.id} and tier_id = ${tierId}`;

    // The last point a refusal is free. On the x402 rail, completion has already
    // settled irreversibly, so this check has to happen before payment starts.
    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(refused(session)).toBe(true);
  });
});

/**
 * Recurring memberships (§18.9).
 *
 * A subscription settles through Stripe's own invoice, not the one-off
 * PaymentIntent the rest of checkout uses — so a cart holding one alongside
 * anything else would need two payments for one basket. These assert the cart is
 * refused **before** stock is reserved or a payment opened, which is the last
 * point a refusal costs nobody anything.
 */
describe("recurring memberships", () => {
  /** Restored after each test so the rest of the suite sees a one-off product. */
  const makeRecurring = (interval: "month" | "year") =>
    sql`update products set grants_renewal_interval = ${interval} where id = ${grantingProductId}`;
  const makeOneOff = () =>
    sql`update products set grants_renewal_interval = 'none' where id = ${grantingProductId}`;

  afterEach(async () => {
    await makeOneOff();
  });

  it("refuses a subscription sharing a cart with anything else", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "recurmixed");
    await makeRecurring("month");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const added = await shopper.patch(`/_sites/${slug}/api/cart/${cart.json.token}`, {
      add: { productId: openProductId, quantity: 1 },
    });
    expect(added.status).toBeLessThan(400);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(refused(session)).toBe(true);
    // It must name the product, or the shopper does not know what to remove.
    expect(JSON.stringify(session.json)).toMatch(/renews automatically|separately/i);
  }, 120_000);

  /**
   * A subscription-only cart is not an error — it belongs on the other route,
   * and the refusal has to say so or a storefront has no way to find it.
   */
  it("points a subscription cart at the subscription endpoint", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "recurroute");
    await makeRecurring("month");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(session.status).toBe(409);
    expect(session.json.error.details.useEndpoint).toBe(
      `/_sites/${slug}/api/checkout/subscription`,
    );
  }, 120_000);

  /**
   * **A subscription needs an account.** A renewal arriving months later has no
   * browser session to attach to, so a guest subscription would be a recurring
   * charge with nobody to give the access to.
   */
  it("refuses a guest buying a subscription", async () => {
    const shopper = shopperClient();
    await makeRecurring("month");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const res = await shopper.post(`/_sites/${slug}/api/checkout/subscription`, {
      cartToken: cart.json.token,
    });
    expect(refused(res)).toBe(true);
    expect(JSON.stringify(res.json)).toMatch(/sign in/i);
  }, 120_000);

  /** The subscription route is not a second way to buy an ordinary product. */
  it("refuses a non-recurring cart on the subscription endpoint", async () => {
    const shopper = shopperClient();
    await signUpShopper(shopper, "recurwrong");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: openProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const res = await shopper.post(`/_sites/${slug}/api/checkout/subscription`, {
      cartToken: cart.json.token,
    });
    expect(refused(res)).toBe(true);
    expect(JSON.stringify(res.json)).toMatch(/no recurring membership|checkout\/session/i);
  }, 120_000);

  /**
   * Two of one subscription is one membership billed twice — there is no second
   * thing to receive.
   */
  it("refuses quantity above one", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "recurqty");
    await makeRecurring("month");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 2,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(refused(session)).toBe(true);
  }, 120_000);

  /**
   * **Never silently falls back to a one-off charge.** A single payment for
   * something sold as a subscription gives the shopper one period and never
   * renews it, while the storefront said it would.
   */
  it("refuses a subscription-only cart rather than charging once", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "reconly");
    await makeRecurring("year");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(refused(session)).toBe(true);
    expect(session.status).toBe(409);
  }, 120_000);

  /** The default must leave every existing product behaving exactly as before. */
  it("leaves a one-off membership product checking out normally", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "reconeoff");

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    expect(cart.status).toBe(201);
    await trackCart(cleanup, cart.json.token);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(refused(session)).toBe(false);
    if (session.json?.id) cleanup.checkoutSessionIds.push(session.json.id);
  }, 120_000);
});

describe("shopper identity (§18.3, D32)", () => {
  it("refuses a staff account at the storefront sign-in", async () => {
    const staff = new Client();
    const m = await signUpMerchant(staff, "staffatshop");
    cleanup.merchantEmails.push(m.email);

    const res = await staff.post(`/_sites/${slug}/api/auth/sign-in`, {
      email: m.email,
      password: m.password,
    });

    // One auth user has one kind. A merchant testing their own store uses a
    // different address rather than being both.
    expect(res.status).toBe(401);
  });

  /**
   * The one test that goes through the real sign-up route. Every other shopper
   * here is created through the admin API so the suite does not trip the
   * project's hourly confirmation-email cap.
   */
  it("stamps user_kind=customer in app_metadata via the real sign-up route", async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const email = `test-shopper-kind-${stamp}@markii.shop`;
    // Registered like every other fixture. Forgetting this is what leaked one
    // shopper per run for four days.
    cleanup.shopperEmails.push(email);
    const shopper = shopperClient();

    const up = await shopper.post(`/_sites/${slug}/api/auth/sign-up`, {
      email,
      password: `Sh!${stamp}bB9`,
    });
    if (up.status >= 400 && /rate limit/i.test(JSON.stringify(up.json))) {
      // The project caps confirmation emails per hour. Skipping is honest;
      // asserting on a refusal that is not about `user_kind` would not be.
      console.warn("[memberships] skipped: Supabase email rate limit");
      return;
    }
    expect(up.status).toBeLessThan(400);

    const [user] = await sql`select raw_app_meta_data, raw_user_meta_data
      from auth.users where email = ${email}`;

    // `user_metadata` is user-writable, so a shopper could otherwise promote
    // themselves by calling `updateUser`. The authoritative copy must be the
    // one only the service role can set.
    expect(user.raw_app_meta_data.user_kind).toBe("customer");
    expect(user.raw_user_meta_data?.user_kind).toBeUndefined();
  });

  it("does not let a shopper session reach the dashboard API", async () => {
    const shopper = shopperClient();
    await signUpShopper(shopper, "crossdomain");

    const me = await shopper.get("/api/me");
    expect(me.status).toBe(401);

    const products = await shopper.get("/api/products");
    expect(products.status).toBe(401);
  });

  it("keeps memberships scoped to the store that granted them", async () => {
    const other = await createTestStore(cleanup, "otherstore", { orgId });
    const otherTier = await merchant.post("/api/actions/memberships.createTier", {
      siteId: other.site.id,
      name: "Silver",
    });
    const otherTierId = otherTier.json.result.id;
    await sql`update products set requires_tier_id = ${otherTierId}
      where id = ${other.products[0].id}`;

    /**
     * A member of this store's Gold tier is not a member of the other store.
     *
     * The harness makes this a **stronger** assertion than it looks: both
     * stores are served from one host here (`/_sites/{slug}/…`), so the shopper's
     * session cookie really does travel to the second store. In production
     * host-only cookies would stop it before this point. What refuses it here is
     * the thing D32 mitigation 1 requires — authorization resolving through the
     * per-store `customers` row, not through `auth.getUser()`.
     */
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "scoped");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;
    await merchant.post("/api/actions/memberships.grant", {
      customerId: customer.id,
      tierId,
      durationDays: 30,
    });

    const res = await shopper.post(`/_sites/${other.slug}/api/cart`, {
      productId: other.products[0].id,
      quantity: 1,
    });
    expect(refused(res)).toBe(true);
  });

  it("refuses to grant a tier belonging to a different store than the customer", async () => {
    const other = await createTestStore(cleanup, "mismatch", { orgId });
    const otherTier = await merchant.post("/api/actions/memberships.createTier", {
      siteId: other.site.id,
      name: "Bronze",
    });

    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "mismatch");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;

    const res = await merchant.post("/api/actions/memberships.grant", {
      customerId: customer.id,
      tierId: otherTier.json.result.id,
      durationDays: 30,
    });
    expect(refused(res)).toBe(true);
  });
});

describe("membership purchase", () => {
  it("confers the tier in the same transaction as the order", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "buyer");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    await trackCart(cleanup, cart.json.token);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    expect(session.status).toBeLessThan(400);

    const done = await shopper.post(
      `/_sites/${slug}/api/checkout/session/${session.json.id}/complete`,
      { paymentReference: `test-membership-${Date.now()}` },
    );
    expect(done.status).toBeLessThan(400);
    if (done.json?.orderId) cleanup.orderIds.push(done.json.orderId);

    const [membership] = await sql`select * from customer_memberships
      where customer_id = ${customer.id} and tier_id = ${tierId}`;

    expect(membership, "a paid order must never exist without the access it sold").toBeTruthy();
    expect(membership.source).toBe("purchase");
    expect(membership.order_id).not.toBeNull();
    expect(membership.ends_at).not.toBeNull();

    // The gated product is now reachable for the same shopper.
    const allowed = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(allowed.status).toBe(201);
    await trackCart(cleanup, allowed.json.token);
  }, 120_000);

  it("takes the membership back when the order is refunded", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "refunded");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;

    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    await trackCart(cleanup, cart.json.token);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    const done = await shopper.post(
      `/_sites/${slug}/api/checkout/session/${session.json.id}/complete`,
      { paymentReference: `test-refund-membership-${Date.now()}` },
    );
    expect(done.status).toBeLessThan(400);
    const orderId = done.json.orderId;
    cleanup.orderIds.push(orderId);

    // An itemised order is refunded by line — `computeRefund` refuses a request
    // that names neither lines nor an amount.
    const lines = await sql`select id, product_id from order_lines
      where order_id = ${orderId}`;
    const membershipLine = lines.find((l: any) => l.product_id === grantingProductId);
    expect(membershipLine, "the order should carry the membership line").toBeTruthy();

    // Buy, use, refund, keep the access is the digital-goods fraud pattern.
    // Closed for downloads already; this proves it is closed here too.
    const refund = await merchant.invoke("orders.refund", {
      orderId,
      reason: "requested_by_customer",
      restock: false,
      lines: [{ orderLineId: membershipLine!.id, quantity: 1 }],
    });
    expect(refused(refund), JSON.stringify(refund.json)).toBe(false);

    const [membership] = await sql`select revoked_at from customer_memberships
      where customer_id = ${customer.id} and tier_id = ${tierId}`;
    expect(membership.revoked_at, "a refunded membership must not keep working").not.toBeNull();

    const denied = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: gatedProductId,
      quantity: 1,
    });
    expect(refused(denied)).toBe(true);
  }, 120_000);

  it("does not revoke a membership when an unrelated line is refunded", async () => {
    const shopper = shopperClient();
    const { email } = await signUpShopper(shopper, "partialrefund");
    const [customer] = await sql`select id from customers
      where site_id = ${siteId} and email = ${email}`;

    // One membership line and one ordinary line in the same order.
    const cart = await shopper.post(`/_sites/${slug}/api/cart`, {
      productId: grantingProductId,
      quantity: 1,
    });
    await trackCart(cleanup, cart.json.token);
    const added = await shopper.patch(`/_sites/${slug}/api/cart/${cart.json.token}`, {
      add: { productId: openProductId, quantity: 1 },
    });
    expect(added.status).toBeLessThan(400);

    const session = await shopper.post(`/_sites/${slug}/api/checkout/session`, {
      cartToken: cart.json.token,
      rail: "x402",
      email,
    });
    const done = await shopper.post(
      `/_sites/${slug}/api/checkout/session/${session.json.id}/complete`,
      { paymentReference: `test-partial-${Date.now()}` },
    );
    expect(done.status).toBeLessThan(400);
    cleanup.orderIds.push(done.json.orderId);

    const lines = await sql`select id, product_id from order_lines
      where order_id = ${done.json.orderId}`;
    const openLine = lines.find((l: any) => l.product_id === openProductId);
    expect(openLine, "the order should carry the non-membership line").toBeTruthy();

    // Refunding the t-shirt must not cancel the membership.
    const refund = await merchant.invoke("orders.refund", {
      orderId: done.json.orderId,
      reason: "requested_by_customer",
      restock: false,
      lines: [{ orderLineId: openLine!.id, quantity: 1 }],
    });
    expect(refused(refund)).toBe(false);

    const [membership] = await sql`select revoked_at from customer_memberships
      where customer_id = ${customer.id} and tier_id = ${tierId}`;
    expect(membership.revoked_at, "a partial refund must not over-revoke").toBeNull();
  }, 120_000);
});
