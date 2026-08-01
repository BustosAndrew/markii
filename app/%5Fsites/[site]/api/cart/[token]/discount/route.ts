import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { cartResponse, loadCart, loadStore } from "@/lib/commerce/cart";
import { carts, db } from "@/lib/db";

/**
 * `POST /api/cart/:token/discount` (§18.4) — apply or remove a code.
 *
 * The code is **stored, not honoured**. Discounts are §18.5 and are not built,
 * so this route deliberately does not answer "is this code valid?" — it has no
 * table to check. Accepting a code and showing a reduced total would be the
 * exact failure `CLAUDE.md` forbids: implying something happened when it did
 * not, at the one moment a shopper is deciding whether to pay.
 *
 * So the response echoes the code with `applied: false` and a reason, and
 * `discount.state` on the cart stays `not_configured`. When §18.5 lands, this
 * route validates against real discounts and nothing else here changes.
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

  const next =
    action === "remove"
      ? cart.discountCodes.filter((c) => c !== normalized)
      : [...new Set([...cart.discountCodes, normalized])];

  const [updated] = await db
    .update(carts)
    .set({ discountCodes: next, updatedAt: new Date() })
    .where(eq(carts.id, cart.id))
    .returning();

  return NextResponse.json({
    ...(await cartResponse(updated)),
    codeResult:
      action === "remove"
        ? { code: normalized, removed: true }
        : {
            code: normalized,
            applied: false,
            reason:
              "Discount codes are not yet supported on this store. The code has been saved to " +
              "the cart and will be evaluated once discounts are available (docs/API.md §18.5).",
          },
  });
});
