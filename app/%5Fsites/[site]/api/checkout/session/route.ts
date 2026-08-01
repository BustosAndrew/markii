import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, conflict, handler } from "@/lib/api";
import { assertPurchasable, loadCart, loadStore, setCartContact } from "@/lib/commerce/cart";
import { priceCart } from "@/lib/commerce/pricing";
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

  const priced = await priceCart(cart);
  if (priced.lines.length === 0) throw badRequest("Cart is empty");
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

  const payment = await startPayment({
    rail: input.rail,
    orgId: site.orgId,
    siteWallet: site.walletAddress,
  });
  if (!payment.ok) {
    // Refused before anything is reserved — a shopper who cannot pay must not
    // be holding the last unit of someone else's order.
    return NextResponse.json(
      { error: { code: "CONFLICT", message: payment.message, details: payment } },
      { status: 409 },
    );
  }

  // Reclaim stock from checkouts that were abandoned, so an idle store does not
  // refuse a real sale for inventory nobody is buying.
  await sweepExpiredReservations();

  const sessionId = randomUUID();
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
