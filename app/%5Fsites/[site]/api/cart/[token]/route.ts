import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handler } from "@/lib/api";
import {
  addLine,
  assertPurchasable,
  cartResponse,
  loadCart,
  loadStore,
  setCartContact,
  setLineQuantity,
} from "@/lib/commerce/cart";

/** `GET`/`PATCH` `/api/cart/:token` (§18.4). */

const addressSchema = z.object({
  name: z.string().max(120).nullish(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullish(),
  city: z.string().min(1).max(120),
  province: z.string().max(120).nullish(),
  postalCode: z.string().max(40).nullish(),
  country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
  phone: z.string().max(40).nullish(),
});

/**
 * One PATCH body covers every cart mutation. Note what is **not** here: no
 * price, no total, no discount amount. §18.4's non-negotiable rule is that a
 * client-supplied amount is never trusted, and the cleanest way to honour that
 * is to give the client no field to supply one in.
 */
const patchSchema = z.object({
  add: z
    .object({
      productId: z.number().int().positive(),
      variantId: z.number().int().positive().nullish(),
      quantity: z.number().int().positive().max(999).default(1),
      addOnIds: z.array(z.number().int().positive()).max(20).optional(),
    })
    .optional(),
  /** Quantity 0 removes the line. */
  setQuantity: z
    .object({ lineId: z.number().int().positive(), quantity: z.number().int().min(0).max(999) })
    .optional(),
  email: z.email().max(255).nullish(),
  shippingAddress: addressSchema.nullish(),
  shippingRateId: z.string().max(120).nullish(),
});

export const GET = handler(async (_req, { params }) => {
  const { site: slug, token } = await params;
  const site = await loadStore(slug);
  const cart = await loadCart(site, token);
  return NextResponse.json(await cartResponse(cart));
});

export const PATCH = handler(async (req, { params }) => {
  const { site: slug, token } = await params;
  const site = await loadStore(slug);
  assertPurchasable(site);

  const input = patchSchema.parse(JSON.parse((await req.text()) || "{}"));
  if (Object.keys(input).length === 0) throw badRequest("No changes supplied");

  let cart = await loadCart(site, token);
  if (input.add) {
    cart = await addLine(site, cart, {
      productId: input.add.productId,
      variantId: input.add.variantId,
      quantity: input.add.quantity,
      addOnIds: input.add.addOnIds,
    });
  }
  if (input.setQuantity) {
    cart = await setLineQuantity(cart, input.setQuantity.lineId, input.setQuantity.quantity);
  }
  if (
    input.email !== undefined ||
    input.shippingAddress !== undefined ||
    input.shippingRateId !== undefined
  ) {
    cart = await setCartContact(cart, {
      email: input.email,
      shippingAddress: input.shippingAddress ?? null,
      shippingRateId: input.shippingRateId,
    });
  }

  return NextResponse.json(await cartResponse(cart));
});
