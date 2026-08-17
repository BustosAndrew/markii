import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, conflict, handler, notFound } from "@/lib/api";
import { currentCustomerId } from "@/lib/auth/shopper";
import { assertPurchasable, attachShopper, loadCart, loadStore } from "@/lib/commerce/cart";
import {
  createMembershipSubscription,
  createRecurringPrice,
  ensureShopperCustomer,
  type MembershipBillingFailure,
} from "@/lib/commerce/membership-billing";
import { recurringMembershipInCart } from "@/lib/commerce/memberships";
import { priceCart } from "@/lib/commerce/pricing";
import { taxSettingsFor } from "@/lib/commerce/tax";
import { customers, db, products } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import { matchedPublishableKey } from "@/lib/stripe-mode";

/**
 * `POST /_sites/{slug}/api/checkout/subscription` (§18.9) — buy a recurring
 * membership.
 *
 * **Separate from `/checkout/session` on purpose.** That route opens a
 * PaymentIntent for a fixed total and reserves stock; a subscription does
 * neither. It settles through Stripe's own recurring invoice, has no stock, and
 * its "total" repeats forever. Forking inside one route would mean two
 * incompatible payment shapes behind one contract, and the branch that did not
 * apply would still be reading the other's fields.
 *
 * **The subscription lives on the merchant's connected account** — shopper pays
 * merchant, Markii takes no cut (D4), same as every other rail.
 *
 * **Nothing here grants the membership.** The subscription starts `incomplete`
 * until the shopper confirms payment in Elements, and the Connect `invoice.paid`
 * webhook is what creates and extends the membership. Granting on creation would
 * hand out access before the card was charged — the free-goods bug, in a
 * recurring costume that keeps giving.
 *
 * That is also why no membership row is written here. There is no honest state
 * for "exists but not yet paid": `revoked` means the merchant took it away and
 * a far-future `startsAt` is a fiction. The subscription carries the customer
 * and product in its metadata, and the webhook resolves the tier from those.
 */

const bodySchema = z.object({
  cartToken: z.string().min(1).max(200),
  email: z.email().max(255).optional(),
});

/** Stripe's refusal, in the storefront's own error shape. */
function refuse(failure: MembershipBillingFailure) {
  return NextResponse.json(
    {
      error: {
        code: failure.code === "configuration_required" ? "CONFIGURATION_REQUIRED" : "CONFLICT",
        message: failure.message,
        ...(failure.resolution ? { details: { resolution: failure.resolution } } : {}),
      },
    },
    { status: failure.code === "configuration_required" ? 503 : 409 },
  );
}

export const POST = handler(async (req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);
  assertPurchasable(site);

  const raw = await req.text();
  const input = bodySchema.parse(raw ? JSON.parse(raw) : {});

  let cart = await loadCart(site, input.cartToken);
  if (!cart) throw notFound("Cart");

  /**
   * Claim the cart for the signed-in shopper before anything else, exactly as
   * the one-off route does — signing in *after* filling a basket is the ordinary
   * order of events, and a subscription with no customer attached has nobody to
   * give the membership to.
   */
  cart = await attachShopper(site, cart);

  const priced = await priceCart(cart);
  if (priced.lines.length === 0) throw badRequest("Cart is empty");

  /**
   * The same guard the one-off route uses, so the two cannot disagree about what
   * a subscription cart may contain. It throws on a mixed basket or a quantity
   * above one; a `null` here means this cart belongs on the other route.
   */
  const recurring = await recurringMembershipInCart(
    site.id,
    priced.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
  );
  if (!recurring) {
    throw badRequest(
      "This cart has no recurring membership in it. Use /api/checkout/session for a one-off order.",
    );
  }

  /**
   * **A subscription needs a shopper account**, and this is the one place that
   * is a hard requirement rather than a convenience. The membership hangs off a
   * `customers` row, and a renewal arriving months later has no browser session
   * to attach itself to — a guest subscription would be a recurring charge with
   * nobody to give the access to.
   */
  const customerId = await currentCustomerId(site.id);
  if (customerId === null) {
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "Sign in to buy a membership — it renews, so it needs an account to belong to.",
          details: {
            resolution: `Sign in or create an account at /_sites/${slug}, then check out again.`,
          },
        },
      },
      { status: 409 },
    );
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer) throw notFound("Customer");

  /**
   * The merchant's own Stripe account. Connected is not the same as able to take
   * money — `chargesEnabled` is the honest gate, the same one the card rail
   * uses.
   */
  const connection = await getIntegration(site.orgId, "stripe");
  if (connection?.status !== "connected" || !connection.config.accountId) {
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "Memberships are not available on this store yet.",
          details: { resolution: "The store owner needs to connect Stripe in Settings → Payments." },
        },
      },
      { status: 409 },
    );
  }
  if (connection.config.chargesEnabled !== "true") {
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "This store cannot take payments yet.",
          details: { resolution: "Stripe has not finished verifying the store owner's account." },
        },
      },
      { status: 409 },
    );
  }
  const accountId = connection.config.accountId;

  const publishableKey = matchedPublishableKey();
  if (!publishableKey) {
    /**
     * Refused before a subscription exists. Elements cannot mount without a
     * key, or with one from the other Stripe mode, and opening a subscription
     * the shopper has no way to confirm leaves an `incomplete` subscription on
     * the merchant's account for a purchase that never happened.
     */
    return NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_REQUIRED",
          message: "Card payments are not fully configured on this platform.",
          details: {
            resolution:
              "Card payments need additional platform configuration. Contact the store owner.",
          },
        },
      },
      { status: 503 },
    );
  }

  /**
   * The line's own price, frozen by `priceCart`, rather than anything the client
   * sent. §18.4's non-negotiable rule: a client-supplied amount is never
   * trusted, and a subscription would repeat the mistake monthly.
   */
  const line = priced.lines.find((l) => l.productId === recurring.productId);
  if (!line) throw conflict("The membership line vanished while pricing the cart.");
  const amountMinor = Math.round(line.unitPriceMinor);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw conflict("A membership must have a price before it can be sold as a subscription.");
  }

  /**
   * Created once and stored on the product. A fresh Price per checkout would
   * work but would litter the merchant's own Stripe dashboard with hundreds of
   * identical prices for one plan — and they are the ones who have to read it.
   */
  let priceId = recurring.stripeRecurringPriceId;
  if (!priceId) {
    const created = await createRecurringPrice({
      accountId,
      productId: recurring.productId,
      productName: recurring.name,
      amountMinor,
      currency: priced.currency,
      interval: recurring.interval,
    });
    if (!created.ok) return refuse(created);
    priceId = created.priceId;

    await db
      .update(products)
      .set({ stripeRecurringPriceId: priceId, updatedAt: new Date() })
      .where(eq(products.id, recurring.productId));
  }

  /**
   * **Stripe Tax on the subscription, or nothing taxes the renewals** (§18.6).
   *
   * A one-off checkout is taxed by `priceCart` at the moment of sale. A
   * subscription has no such moment after the first: Stripe invoices it months
   * later, and nothing in Markii runs on a clock to meet it. So the store's tax
   * provider has to be handed to Stripe once, at creation, and left there.
   *
   * **A `manual`-rate store cannot sell one.** Markii's own rates exist only
   * where Markii is in the request, and it never is for a renewal. Selling the
   * membership anyway would tax the first month and silently stop, which is the
   * shape of failure §18.6 refuses over: the merchant would owe tax they never
   * charged, and nothing would tell them.
   */
  const tax = await taxSettingsFor(site.id);
  if (tax.provider === "manual") {
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "This store cannot sell auto-renewing memberships yet.",
          details: {
            resolution:
              "Renewals are invoiced by Stripe months later, so they can only be taxed by Stripe " +
              "Tax. Switch this store's tax provider to Stripe Tax in Settings → Tax, or sell " +
              "this membership as a one-off product.",
          },
        },
      },
      { status: 409 },
    );
  }

  /**
   * Stripe Tax locates the shopper from the **customer**, not the cart — there
   * is no cart at renewal time. Without a location Stripe refuses the invoice
   * outright, so this is refused here, before a subscription exists, rather than
   * on invoice one with the shopper watching.
   */
  const taxAddress = cart.shippingAddress ?? null;
  if (tax.provider === "stripe" && !taxAddress?.country) {
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "An address is needed before this membership can be bought.",
          details: {
            resolution:
              "This store calculates tax with Stripe Tax, which needs to know where you are — " +
              "add an address to your cart and check out again.",
          },
        },
      },
      { status: 409 },
    );
  }

  const shopper = await ensureShopperCustomer({
    accountId,
    customerId: customer.id,
    existingStripeCustomerId: customer.stripeCustomerId,
    email: input.email ?? customer.email,
    name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null,
    address: tax.provider === "stripe" ? taxAddress : null,
  });
  if (!shopper.ok) return refuse(shopper);

  /**
   * Persisted **before** the subscription is created, so a failure below still
   * leaves the id recorded and the retry reuses this customer. Losing it would
   * mint a second Stripe customer once the idempotency window passed, and the
   * shopper's saved card would sit on the one not being billed.
   */
  if (shopper.stripeCustomerId !== customer.stripeCustomerId) {
    await db
      .update(customers)
      .set({ stripeCustomerId: shopper.stripeCustomerId, updatedAt: new Date() })
      .where(eq(customers.id, customer.id));
  }

  const subscription = await createMembershipSubscription({
    accountId,
    stripeCustomerId: shopper.stripeCustomerId,
    priceId,
    customerId: customer.id,
    productId: recurring.productId,
    /** The store's own choice, carried to the only party that can act on it. */
    automaticTax: tax.provider === "stripe",
  });
  if (!subscription.ok) return refuse(subscription);

  if (!subscription.subscription.clientSecret) {
    /**
     * No secret means the shopper has no way to pay, so the subscription cannot
     * complete. Reported rather than returned as a success — a storefront that
     * showed "subscribed" here would be claiming a payment that never happened.
     */
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: "Stripe did not return a way to confirm this payment.",
          details: { subscriptionId: subscription.subscription.subscriptionId },
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      subscriptionId: subscription.subscription.subscriptionId,
      status: subscription.subscription.status,
      /** Confirmed in Stripe-hosted Elements. Card data never reaches Markii. */
      clientSecret: subscription.subscription.clientSecret,
      publishableKey,
      /** Direct on the merchant's account — Elements needs it to confirm there. */
      stripeAccount: accountId,
      tier: { id: recurring.tierId, productId: recurring.productId, name: recurring.name },
      interval: recurring.interval,
      amountMinor,
      currency: priced.currency,
      /**
       * Stated so no storefront can imply access has started. The membership is
       * granted by the `invoice.paid` webhook once the shopper confirms, not by
       * this response.
       */
      membershipGranted: false,
      note:
        "Confirm the payment to start the membership. Access begins once Stripe reports the " +
        "first invoice paid.",
    },
    { status: 201 },
  );
});
