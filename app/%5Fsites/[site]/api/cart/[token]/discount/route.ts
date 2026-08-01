import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { cartResponse, loadCart, loadStore } from "@/lib/commerce/cart";
import { carts, db } from "@/lib/db";

/**
 * `POST /api/cart/:token/discount` (§18.5) — apply or remove a code.
 *
 * The code is validated against the store's real discounts, and a rejection
 * says **why**: expired, below the minimum, already fully redeemed, not
 * combinable, or simply unrecognised. "Invalid code" for all five would leave a
 * shopper who is £2 short of a threshold with no idea they are £2 short.
 *
 * A rejected code is **not stored**. Keeping it on the cart would show a code
 * that never applies on every subsequent read — except for `below_minimum`,
 * which is the one rejection the shopper can fix by adding to their cart, so
 * that code stays and starts working when they do.
 */
const schema = z.object({
  code: z.string().min(1).max(60),
  action: z.enum(["apply", "remove"]).default("apply"),
});

export const POST = handler(async (req, { params }) => {
  const { site: slug, token } = await params;
  const site = await loadStore(slug);
  const cart = await loadCart(site, token);

  const { code, action } = schema.parse(JSON.parse((await req.text()) || "{}"));
  const normalized = code.trim().toUpperCase();

  if (action === "remove") {
    const [updated] = await db
      .update(carts)
      .set({
        discountCodes: cart.discountCodes.filter((c) => c !== normalized),
        updatedAt: new Date(),
      })
      .where(eq(carts.id, cart.id))
      .returning();
    return NextResponse.json({
      ...(await cartResponse(updated)),
      codeResult: { code: normalized, removed: true },
    });
  }

  // Add it, price the cart, and let the engine decide — evaluating here as well
  // would be a second implementation of the rules that could disagree with the
  // one checkout uses.
  const [withCode] = await db
    .update(carts)
    .set({
      discountCodes: [...new Set([...cart.discountCodes, normalized])],
      updatedAt: new Date(),
    })
    .where(eq(carts.id, cart.id))
    .returning();

  const response = await cartResponse(withCode);
  const rejection = response.rejectedCodes.find((r) => r.code === normalized);
  const applied = response.discounts.find((d) => d.code === normalized);

  if (rejection && rejection.reason.code !== "below_minimum") {
    const [reverted] = await db
      .update(carts)
      .set({ discountCodes: cart.discountCodes, updatedAt: new Date() })
      .where(eq(carts.id, cart.id))
      .returning();
    return NextResponse.json(
      {
        ...(await cartResponse(reverted)),
        // `reason` stays nested: it has its own `code` field naming the *kind*
        // of rejection, which flattening would silently overwrite with the
        // discount code the shopper typed.
        codeResult: { code: normalized, applied: false, reason: rejection.reason },
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ...response,
    codeResult: applied
      ? { code: normalized, applied: true, amountMinor: applied.amountMinor, title: applied.title }
      : { code: normalized, applied: false, reason: rejection!.reason },
  });
});
