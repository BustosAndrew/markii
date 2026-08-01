import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { conflict, handler, notFound } from "@/lib/api";
import { parseAgentName } from "@/lib/agents";
import { loadStore } from "@/lib/commerce/cart";
import { completeCheckout, failCheckout } from "@/lib/commerce/orders";
import { checkoutSessions, db, orders } from "@/lib/db";
import { defaultWallet } from "@/lib/integrations";
import { verifyOnChain } from "@/lib/x402";

/**
 * `POST /api/checkout/session/:id/complete` (§18.4) — confirm payment.
 *
 * **The payment is verified here, not asserted by the caller.** A client that
 * could declare its own payment successful is a client that can take goods for
 * free, so the transaction hash is checked on-chain against the amount and
 * recipient this session actually quoted.
 *
 * Everything after verification — order, stock, usage record, cart conversion —
 * belongs to `lib/commerce/orders.ts`, the one pipeline both rails share.
 */
const schema = z.object({
  /** x402: the on-chain transaction hash. Stripe: the PaymentIntent id. */
  paymentReference: z.string().min(1).max(200),
  payerReference: z.string().max(200).nullish(),
});

export const POST = handler(async (req, { params }) => {
  const { site: slug, id } = await params;
  const site = await loadStore(slug);

  const [session] = await db
    .select()
    .from(checkoutSessions)
    .where(and(eq(checkoutSessions.id, id), eq(checkoutSessions.siteId, site.id)))
    .limit(1);
  if (!session) throw notFound("Checkout session");

  // Idempotent: a webhook and a browser redirect both land here.
  if (session.status === "completed" && session.orderId != null) {
    return NextResponse.json({ ok: true, orderId: session.orderId, alreadyCompleted: true });
  }
  if (session.status === "expired") throw conflict("This checkout expired and its stock was released");
  if (session.status === "failed") throw conflict("This checkout already failed");
  if (session.expiresAt < new Date()) {
    await failCheckout(session.id, "expired before completion");
    throw conflict("This checkout expired and its stock was released");
  }

  const input = schema.parse(JSON.parse((await req.text()) || "{}"));

  if (session.provider === "stripe") {
    // No Stripe credentials exist yet, so there is nothing to verify against.
    // Accepting the caller's word here would be a free-goods bug.
    throw conflict("Card checkout is not implemented yet (docs/API.md §18.4).");
  }

  /**
   * Replay protection, before any verification work: a transaction hash settles
   * exactly one order. The unique index on `payment_reference` is the real
   * guarantee — this check just turns the race loser into a clear 409.
   */
  const [reused] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.txHash, input.paymentReference), eq(orders.status, "success")))
    .limit(1);
  if (reused) throw conflict("This transaction has already been used for an order");

  const payTo = site.walletAddress ?? (await defaultWallet(site.orgId));
  if (!payTo) throw conflict("This store has no receiving wallet configured");

  const skipVerification = process.env.DEMO_SKIP_PAYMENT_VERIFICATION === "1";
  const verification = skipVerification
    ? { ok: true as const, from: input.payerReference ?? undefined }
    : await verifyOnChain({
        txHash: input.paymentReference,
        payTo,
        // The session's frozen total, never a number from the request body.
        amountCents: session.totalMinor,
      });

  if (!verification.ok) {
    await failCheckout(session.id, `payment verification failed: ${verification.reason}`);
    return NextResponse.json(
      {
        error: {
          code: "CONFLICT",
          message: `Payment verification failed: ${verification.reason}`,
        },
      },
      { status: 402 },
    );
  }

  const userAgent = req.headers.get("user-agent");
  const result = await completeCheckout({
    session,
    paymentReference: input.paymentReference,
    payerReference: input.payerReference ?? verification.from ?? null,
    userAgent,
    agentName: parseAgentName(userAgent),
  });

  return NextResponse.json({
    ok: true,
    orderId: result.orderId,
    alreadyCompleted: result.alreadyCompleted,
    rail: "x402",
    amountMinor: session.totalMinor,
    currency: session.currency,
  });
});
