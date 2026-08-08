import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, conflict, handler } from "@/lib/api";
import { currentCustomerId } from "@/lib/auth/shopper";
import {
  assertPurchasable,
  attachShopper,
  loadCart,
  loadStore,
  setCartContact,
} from "@/lib/commerce/cart";
import { assertCartAccess, recurringMembershipInCart } from "@/lib/commerce/memberships";
import { priceCart, snapshotLines } from "@/lib/commerce/pricing";
import {
  RESERVATION_TTL_MS,
  reservationsForCart,
  reserveForSession,
  sweepExpiredReservations,
} from "@/lib/commerce/reservations";
import { checkoutSessions, db } from "@/lib/db";
import { startPayment } from "@/lib/payments";

/**
 * `POST /api/checkout/session` (§18.4) — open a checkout for a cart.
 *
 * This is the moment three things happen together and must not come apart:
 * the price is recomputed and **frozen**, stock is **reserved**, and a payment
 * is started on the chosen rail. Reservation and session creation share one
 * transaction, so a checkout can never exist holding no stock, and stock can
 * never be held by a checkout that failed to open.
 *
 * A `provisional` total cannot open a checkout. Tax and shipping are not
 * calculable yet (§18.6), so a store selling shippable goods gets a clear
 * refusal instead of an under-collected total the merchant would eat.
 */
const schema = z.object({
  cartToken: z.string().min(1).max(200),
  rail: z.enum(["stripe", "x402"]).default("x402"),
  email: z.email().max(255).optional(),
});

export const POST = handler(async (req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);
  assertPurchasable(site);

  const input = schema.parse(JSON.parse((await req.text()) || "{}"));
  if (!site.paymentProviders[input.rail]) {
    throw conflict(`This store does not accept ${input.rail} payments`);
  }

  let cart = await loadCart(site, input.cartToken);
  if (input.email) cart = await setCartContact(cart, { email: input.email });

  /**
   * Claim the cart for the signed-in shopper before the session freezes its
   * `customerId`. Done here rather than at cart creation because signing in
   * *after* filling a basket is the ordinary order of events.
   */
  cart = await attachShopper(site, cart);

  const priced = await priceCart(cart);
  if (priced.lines.length === 0) throw badRequest("Cart is empty");

  /**
   * Re-check the membership gate (§18.9) **before** payment starts, not after.
   *
   * `addLine` already refused anything the shopper could not access, but a
   * membership can lapse between filling a cart and paying for it. Checking here
   * is the last point where a refusal costs nobody anything; the same check at
   * completion would take money on the x402 rail — which settles irreversibly —
   * and then decline to hand over the goods.
   */
  await assertCartAccess(site.id, priced.lines, await currentCustomerId(site.id));

  /**
   * A recurring membership (§18.9) does not settle through a PaymentIntent — it
   * settles through Stripe's own subscription invoice — so a cart holding one
   * alongside anything else would need two payments for one basket.
   *
   * Refused **here**, before stock is reserved or a payment opened, because this
   * is the last point where a refusal costs nobody anything. It throws a `409`
   * naming the product, so the shopper knows what to remove.
   */
  const recurring = await recurringMembershipInCart(
    site.id,
    priced.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
  );
  if (recurring) {
    /**
     * Sent to the subscription route rather than charged once here. A single
     * PaymentIntent for something sold as a subscription would give the shopper
     * one period and never renew it, while the storefront said otherwise — the
     * fabricated-success rule applied to a purchase.
     *
     * A `409` with the destination, not a redirect: the two routes return
     * different shapes (a client secret confirmed against the *merchant's*
     * account, not a PaymentIntent), so a client that followed a 3xx blindly
     * would read fields that are not there.
     */
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: `"${recurring.name}" renews automatically, so it is bought as a subscription.`,
          details: {
            productId: recurring.productId,
            interval: recurring.interval,
            /** Where this cart actually checks out. */
            useEndpoint: `/_sites/${slug}/api/checkout/subscription`,
            resolution:
              `POST the same cartToken to /_sites/${slug}/api/checkout/subscription. It returns a ` +
              "client secret to confirm in Stripe Elements against the store's own account.",
          },
        },
      },
      { status: 409 },
    );
  }

  if (priced.issues.length > 0) {
    throw conflict(
      "This cart cannot be checked out yet — some items are unavailable or out of stock.",
    );
  }

  /**
   * The honest refusal. `provisional` means a component of the total could not
   * be calculated, and charging a total that is missing tax or shipping bills
   * the shopper an amount nobody can stand behind.
   */
  if (priced.totalState !== "final") {
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message:
            "This cart contains items that require shipping, and this store has not configured " +
            "shipping rates yet.",
          details: {
            missing: ["shipping"],
            note: priced.shipping.note,
            resolution:
              "Configure shipping zones and rates (docs/API.md §18.6). Until then this store " +
              "cannot quote a total it is able to honour, and charging zero shipping would " +
              "leave the merchant paying the cost.",
          },
        },
      },
      { status: 409 },
    );
  }

  /**
   * Minted before the payment starts, because on the card rail it *is* the
   * idempotency key: a retried session creation reuses the same PaymentIntent
   * rather than opening a second authorisation on the shopper's card.
   */
  const sessionId = randomUUID();

  const payment = await startPayment({
    rail: input.rail,
    orgId: site.orgId,
    siteWallet: site.walletAddress,
    charge: {
      amountMinor: priced.totalMinor,
      currency: priced.currency,
      sessionId,
      siteId: site.id,
      email: cart.email,
    },
  });
  if (!payment.ok) {
    // Refused before anything is reserved — a shopper who cannot pay must not
    // be holding the last unit of someone else's order.
    return NextResponse.json(
      { error: { code: "CONFLICT", message: payment.message, details: payment } },
      { status: 409 },
    );
  }

  /**
   * The PaymentIntent id, stored so the webhook can find this checkout when
   * Stripe reports the payment. `payment_reference` is uniquely indexed, which
   * is what stops one intent settling two sessions.
   *
   * If the reservation below fails, this intent is orphaned. It is never
   * confirmed, so no money moves and Stripe expires it on its own — preferable
   * to a cancellation call that can itself fail and leave a worse mess.
   */
  const paymentIntentId =
    typeof payment.instructions.paymentIntentId === "string"
      ? payment.instructions.paymentIntentId
      : null;

  // Reclaim stock from checkouts that were abandoned, so an idle store does not
  // refuse a real sale for inventory nobody is buying.
  await sweepExpiredReservations();

  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
  const requests = await reservationsForCart(cart.id);

  await db.transaction(async (tx) => {
    await tx.insert(checkoutSessions).values({
      id: sessionId,
      cartId: cart.id,
      siteId: site.id,
      customerId: cart.customerId,
      email: cart.email,
      provider: input.rail,
      subtotalMinor: priced.subtotalMinor,
      discountMinor: priced.discount.amountMinor,
      taxMinor: priced.tax.amountMinor,
      shippingMinor: priced.shipping.amountMinor,
      totalMinor: priced.totalMinor,
      currency: priced.currency,
      shippingAddress: cart.shippingAddress ?? null,
      appliedDiscounts: priced.discounts.map((d) => ({
        discountId: d.discountId,
        code: d.code,
        amountMinor: d.amountMinor,
      })),
      // Frozen with the quote, for the same reason the amounts are: these
      // become the order's lines, and lines that do not sum to the subtotal
      // charged are a refund that returns the wrong money (§18.7).
      lineSnapshot: snapshotLines(priced),
      paymentReference: paymentIntentId,
      expiresAt,
    });
    await reserveForSession(tx, sessionId, requests, expiresAt);
  });

  const [session] = await db
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, sessionId))
    .limit(1);

  return NextResponse.json(
    {
      id: session.id,
      status: session.status,
      rail: session.provider,
      currency: session.currency,
      subtotalMinor: session.subtotalMinor,
      discountMinor: session.discountMinor,
      taxMinor: session.taxMinor,
      shippingMinor: session.shippingMinor,
      totalMinor: session.totalMinor,
      /** The frozen quote. These are the numbers the shopper agreed to. */
      amountsAreFinal: true,
      payment: payment.instructions,
      expiresAt: session.expiresAt.toISOString(),
    },
    { status: 201 },
  );
});
