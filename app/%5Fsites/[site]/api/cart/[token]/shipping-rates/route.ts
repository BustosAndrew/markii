import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { loadCart, loadStore } from "@/lib/commerce/cart";

/**
 * `POST /api/cart/:token/shipping-rates` (§18.4) — quote rates for an address.
 *
 * Shipping *rate configuration* is §18.6 and does not exist, so there are no
 * rates to quote. This returns an empty list with an explicit reason rather
 * than a plausible-looking "Standard — $5.00", which would be a fabricated
 * price the merchant never set and cannot honour.
 *
 * Rate *shopping* with carriers is out of scope permanently (`docs/PLAN.md` §3):
 * Markii does everything Shopify does **except fulfillment logistics**.
 */
export const POST = handler(async (_req, { params }) => {
  const { site: slug, token } = await params;
  const site = await loadStore(slug);
  await loadCart(site, token);

  return NextResponse.json({
    rates: [],
    state: "not_configured",
    reason:
      "This store has not configured shipping zones or rates yet (docs/API.md §18.6). " +
      "No rate is quoted because none exists — this is not a free-shipping offer.",
  });
});
