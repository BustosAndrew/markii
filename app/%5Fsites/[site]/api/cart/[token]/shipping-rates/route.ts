import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { loadCart, loadStore, setCartContact } from "@/lib/commerce/cart";
import { priceCart } from "@/lib/commerce/pricing";
import { quoteShipping } from "@/lib/commerce/shipping";

/**
 * `POST /api/cart/:token/shipping-rates` (§18.6) — quote rates for an address.
 *
 * Rates come from the merchant's own zones and rate table. Rate *shopping* with
 * carriers is permanently out of scope (`docs/PLAN.md` §3) — Markii does
 * everything Shopify does **except fulfillment logistics**.
 *
 * Every unquotable case keeps its own `state` and reason. "No zones configured",
 * "we do not ship there", "no rate matches this cart", and "nothing here needs
 * shipping" are four different answers, and only the last one means free.
 */
const schema = z.object({
  address: z
    .object({
      name: z.string().max(120).nullish(),
      line1: z.string().max(200).optional(),
      line2: z.string().max(200).nullish(),
      city: z.string().max(120).optional(),
      province: z.string().max(120).nullish(),
      postalCode: z.string().max(40).nullish(),
      country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
      phone: z.string().max(40).nullish(),
    })
    .optional(),
  /** Persist the address onto the cart so checkout prices the same destination. */
  save: z.boolean().default(true),
});

export const POST = handler(async (req, { params }) => {
  const { site: slug, token } = await params;
  const site = await loadStore(slug);
  let cart = await loadCart(site, token);

  const input = schema.parse(JSON.parse((await req.text()) || "{}"));
  const address = input.address
    ? {
        ...input.address,
        country: input.address.country.toUpperCase(),
        line1: input.address.line1 ?? "",
        city: input.address.city ?? "",
      }
    : (cart.shippingAddress ?? null);

  // Quoting against one address and checking out against another is how a
  // shopper gets charged a rate they never saw.
  if (input.address && input.save) {
    cart = await setCartContact(cart, { shippingAddress: address });
  }

  const priced = await priceCart(cart);
  const quote = await quoteShipping({
    siteId: site.id,
    cartId: cart.id,
    address,
    subtotalMinor: priced.subtotalMinor,
  });

  return NextResponse.json({
    state: quote.state,
    rates: quote.rates,
    ...(quote.state === "quoted" ? { zone: quote.zone } : {}),
    ...("reason" in quote ? { reason: quote.reason } : {}),
    selectedRateId: cart.shippingRateId,
  });
});
