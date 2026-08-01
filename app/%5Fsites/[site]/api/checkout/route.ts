import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { logTraffic, parseAgentName } from "@/lib/agents";
import { badRequest, handler, notFound } from "@/lib/api";
import { createCart } from "@/lib/commerce/cart";
import { completeCheckout } from "@/lib/commerce/orders";
import { availableToSell } from "@/lib/commerce/pricing";
import {
  RESERVATION_TTL_MS,
  locationForVariant,
  reserveForSession,
  sweepExpiredReservations,
} from "@/lib/commerce/reservations";
import { cartLines, carts, checkoutSessions, db, orders, variants } from "@/lib/db";
import { defaultWallet } from "@/lib/integrations";
import { buildChallenge, decodePaymentHeader, verifyOnChain } from "@/lib/x402";
import { checkoutSchema } from "@/lib/validation";
import { loadSite } from "@/lib/storefront";

/**
 * The x402 agent checkout — one shot: challenge, pay, present the hash.
 *
 * §18.4 keeps this as "a peer path into the same order pipeline [that] must
 * write the same usage records", and that is what changed here: order creation,
 * stock movement, and the §17 metering event now go through
 * `lib/commerce/orders.ts` exactly as the human cart checkout does. Two rails,
 * one pipeline — which is the only way the threshold meter can be trusted, since
 * a sale that bypassed it would be invisible to billing forever.
 *
 * **What deliberately did not change is the quote.** This route still charges
 * `price × quantity`, with no tax or shipping, because that is the amount the
 * 402 challenge advertised and the agent has *already paid on-chain* by the time
 * the second request arrives. Refusing after settlement — as the human checkout
 * correctly does before it — would strand the agent's money. When §18.6 lands,
 * the fix belongs in the challenge, so the agent is quoted the full amount up
 * front rather than being surprised at completion.
 */
async function checkout(req: Request, siteSlug: string, input: unknown) {
  const data = await loadSite(siteSlug);
  if (!data) throw notFound("Site");
  const { site, baseUrl } = data;

  if (site.status === "paused") {
    return NextResponse.json({ error: "store is paused" }, { status: 403 });
  }
  if (!site.purchasesEnabled || !site.paymentProviders.x402) {
    return NextResponse.json({ error: "purchases are disabled on this store" }, { status: 403 });
  }

  const { productId, productSlug, quantity } = checkoutSchema.parse(input);
  if (productId == null && !productSlug) throw badRequest("productId or productSlug is required");
  const product = data.prods.find(
    (p) => (productId != null ? p.id === productId : p.slug === productSlug) && p.enabled,
  );
  if (!product) throw notFound("Product");

  /**
   * Stock has two sources during the variant migration and reading the wrong one
   * oversells: for a variant-backed product the ledger is authoritative and
   * `products.stock` is stale legacy; for everything else `products.stock` is
   * still the only number there is.
   */
  const [defaultVariant] = await db
    .select({ id: variants.id })
    .from(variants)
    .where(eq(variants.productId, product.id))
    .orderBy(variants.position, variants.id)
    .limit(1);

  const available = defaultVariant ? await availableToSell(defaultVariant.id) : product.stock;
  if (available < quantity) {
    return NextResponse.json(
      { error: `insufficient stock: ${available} left, ${quantity} requested` },
      { status: 409 },
    );
  }

  /**
   * Checked *before* the challenge is issued, not at reservation time. A
   * variant with nowhere to hold stock cannot be reserved, and discovering that
   * after the agent has already settled on-chain would take their money for an
   * order the store cannot record.
   */
  if (defaultVariant && (await locationForVariant(defaultVariant.id)) == null) {
    return NextResponse.json(
      { error: "store has no stock location configured for this product" },
      { status: 503 },
    );
  }

  const payTo = site.walletAddress ?? (await defaultWallet(site.orgId));
  if (!payTo) {
    return NextResponse.json(
      { error: "store has no receiving wallet configured" },
      { status: 503 },
    );
  }

  const amountCents = product.priceCents * quantity;
  const userAgent = req.headers.get("user-agent");
  const resource = `${baseUrl}/api/checkout`;
  const challenge = () =>
    buildChallenge({
      resource,
      description: `${quantity}× ${product.name} from ${site.name}`,
      payTo,
      amountCents,
    });

  await logTraffic({ siteId: site.id, path: "/api/checkout", userAgent, productId: product.id });

  const paymentHeader = req.headers.get("x-payment");
  if (!paymentHeader) {
    return NextResponse.json(challenge(), { status: 402 });
  }

  const payload = decodePaymentHeader(paymentHeader);
  const skipVerification = process.env.DEMO_SKIP_PAYMENT_VERIFICATION === "1";
  if (!payload?.txHash && !skipVerification) {
    return NextResponse.json(
      { ...challenge(), error: "X-PAYMENT header must contain a txHash" },
      { status: 402 },
    );
  }

  if (payload?.txHash) {
    const [reused] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.txHash, payload.txHash), eq(orders.status, "success")))
      .limit(1);
    if (reused) {
      return NextResponse.json(
        { error: "this transaction has already been used for an order" },
        { status: 409 },
      );
    }
  }

  const verification = skipVerification
    ? { ok: true as const, from: payload?.from }
    : await verifyOnChain({ txHash: payload!.txHash!, payTo, amountCents });

  /**
   * A failed payment is recorded directly rather than through the pipeline: it
   * produced no sale, so there is nothing to meter and no stock to move. The row
   * exists because "this agent tried and the payment did not verify" is the half
   * of the record a merchant needs during an incident.
   */
  if (!verification.ok) {
    await db.insert(orders).values({
      siteId: site.id,
      productId: product.id,
      quantity,
      status: "failed",
      amountCents,
      currency: "USDC",
      provider: "x402",
      txHash: payload?.txHash ?? null,
      agentUserAgent: userAgent ?? "",
      agentName: parseAgentName(userAgent),
      agentWalletAddress: payload?.from ?? null,
    });
    return NextResponse.json(
      { ...challenge(), error: `payment verification failed: ${verification.reason}` },
      { status: 402 },
    );
  }

  /**
   * Reservation happens *after* verification on this rail, and that is correct
   * rather than a shortcut: x402 settles on-chain before the agent ever calls
   * back, so there is no authorization window to hold stock across. The human
   * card path reserves first because there the authorization really is separate
   * from the capture.
   */
  await sweepExpiredReservations();

  const cart = await createCart(site);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

  await db.transaction(async (tx) => {
    await tx.insert(cartLines).values({
      cartId: cart.id,
      productId: product.id,
      variantId: defaultVariant?.id ?? null,
      quantity,
      unitPriceMinorAtAdd: product.priceCents,
    });
    await tx.insert(checkoutSessions).values({
      id: sessionId,
      cartId: cart.id,
      siteId: site.id,
      provider: "x402",
      status: "processing",
      subtotalMinor: amountCents,
      totalMinor: amountCents,
      currency: product.currency,
      /**
       * One line, built here rather than from `priceCart`: this rail charges
       * exactly what the 402 challenge advertised, and re-pricing at this point
       * could itemise an amount other than the one already settled on-chain.
       */
      lineSnapshot: [
        {
          productId: product.id,
          variantId: defaultVariant?.id ?? null,
          title: product.name,
          variantTitle: null,
          sku: product.sku,
          quantity,
          unitPriceMinor: product.priceCents,
          subtotalMinor: amountCents,
          addOns: [],
        },
      ],
      expiresAt,
    });
    if (defaultVariant) {
      await reserveForSession(
        tx,
        sessionId,
        [{ variantId: defaultVariant.id, quantity }],
        expiresAt,
      );
    }
  });

  const [session] = await db
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, sessionId))
    .limit(1);

  const { orderId } = await completeCheckout({
    session,
    paymentReference: payload?.txHash ?? sessionId,
    payerReference: payload?.from ?? verification.from ?? null,
    userAgent,
    agentName: parseAgentName(userAgent),
  });

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

  // The cart existed only to carry this order's lines through the pipeline.
  await db.update(carts).set({ status: "converted" }).where(eq(carts.id, cart.id));

  return NextResponse.json(
    {
      success: true,
      order: {
        id: order.id,
        product: { id: product.id, name: product.name, slug: product.slug },
        quantity,
        amountCents,
        currency: "USDC",
        txHash: order.txHash,
        status: order.status,
      },
      fulfillment: {
        message: `Order confirmed — ${quantity}× ${product.name}. Thank you for shopping at ${site.name}.`,
        support: `${baseUrl}/agent.md`,
      },
    },
    {
      headers: {
        "x-payment-response": Buffer.from(
          JSON.stringify({ success: true, txHash: order.txHash, network: "base-sepolia" }),
        ).toString("base64"),
      },
    },
  );
}

export const POST = handler(async (req, { params }) => {
  const { site } = await params;
  const raw = await req.text();
  return checkout(req, site, raw ? JSON.parse(raw) : {});
});

// GET makes curl demos easy: /api/checkout?productSlug=x&quantity=1
export const GET = handler(async (req, { params }) => {
  const { site } = await params;
  const sp = new URL(req.url).searchParams;
  return checkout(req, site, {
    productSlug: sp.get("productSlug") ?? undefined,
    productId: sp.get("productId") ? Number(sp.get("productId")) : undefined,
    quantity: sp.get("quantity") ? Number(sp.get("quantity")) : undefined,
  });
});
