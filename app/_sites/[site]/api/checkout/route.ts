import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { logTraffic, parseAgentName } from "@/lib/agents";
import { badRequest, handler, notFound } from "@/lib/api";
import { db, orders, products } from "@/lib/db";
import { defaultWallet } from "@/lib/integrations";
import { buildChallenge, decodePaymentHeader, verifyOnChain } from "@/lib/x402";
import { checkoutSchema } from "@/lib/validation";
import { loadSite } from "@/lib/storefront";

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
  if (product.stock < quantity) {
    return NextResponse.json(
      { error: `insufficient stock: ${product.stock} left, ${quantity} requested` },
      { status: 409 },
    );
  }

  const payTo = site.walletAddress ?? (await defaultWallet());
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

  const [order] = await db
    .insert(orders)
    .values({
      siteId: site.id,
      productId: product.id,
      quantity,
      status: verification.ok ? "success" : "failed",
      amountCents,
      currency: "USDC",
      provider: "x402",
      txHash: payload?.txHash ?? null,
      agentUserAgent: userAgent ?? "",
      agentName: parseAgentName(userAgent),
      agentWalletAddress: payload?.from ?? verification.from ?? null,
    })
    .returning();

  if (!verification.ok) {
    return NextResponse.json(
      { ...challenge(), error: `payment verification failed: ${verification.reason}` },
      { status: 402 },
    );
  }

  await db
    .update(products)
    .set({ stock: sql`greatest(${products.stock} - ${quantity}, 0)`, updatedAt: new Date() })
    .where(eq(products.id, product.id));

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
