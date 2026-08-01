import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { addLine, assertPurchasable, cartResponse, createCart, loadStore } from "@/lib/commerce/cart";

/**
 * `POST /api/cart` on a storefront host (§18.4) — create a cart.
 *
 * **The route lives under the site tree, not at `/api/storefront/cart`.** On a
 * storefront host `proxy.ts` rewrites every path to `/_sites/{slug}/…`, so a
 * platform-shaped path could never be reached by the shopper actually standing
 * in the store. Taking the slug from the host also means a cart cannot be
 * created against a store other than the one being browsed.
 *
 * Server-rendered storefronts stay minimal HTML (`CLAUDE.md`); the cart is one
 * of the three sanctioned islands, and this is the API behind it.
 */
const createSchema = z.object({
  productId: z.number().int().positive().optional(),
  variantId: z.number().int().positive().nullish(),
  quantity: z.number().int().positive().max(999).default(1),
  addOnIds: z.array(z.number().int().positive()).max(20).optional(),
});

export const POST = handler(async (req, { params }) => {
  const { site: slug } = await params;
  const site = await loadStore(slug);
  assertPurchasable(site);

  const raw = await req.text();
  const input = createSchema.parse(raw ? JSON.parse(raw) : {});

  let cart = await createCart(site);
  // An empty cart is valid — the storefront may create one before the first
  // "add to cart" so the token exists for the rest of the session.
  if (input.productId != null) {
    cart = await addLine(site, cart, {
      productId: input.productId,
      variantId: input.variantId,
      quantity: input.quantity,
      addOnIds: input.addOnIds,
    });
  }

  return NextResponse.json(await cartResponse(cart), { status: 201 });
});
