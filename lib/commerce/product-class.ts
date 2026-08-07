import { inArray } from "drizzle-orm";
import { productDigitalAssets, products, type DbHandle } from "../db";

/**
 * Physical or digital, for billing (`docs/PRICING.md` §3).
 *
 * The two carry **different fee rates and separate thresholds**, so every
 * metered pound has to be attributed to one of them at the moment it is metered.
 *
 * **The rule:** a product is `digital` if it delivers a file (§18.8) or confers
 * a membership (§18.9). Everything else is `physical`.
 *
 * Two things that rule deliberately does *not* use:
 *
 * - **`requiresShipping`.** That is a fulfillment property. A consultation or a
 *   service ships nothing and is still not a digital good, and reading the flag
 *   would tax it at the digital rate on a technicality.
 * - **The live catalog, at fee time.** Classification happens at *write* time
 *   and is frozen into the usage record, because a merchant who later detaches
 *   a file from a product must not retroactively move last quarter's sales onto
 *   a different threshold. Same reason `order_lines` snapshots the price.
 *
 * Where a product is genuinely ambiguous the answer is `physical`, which is the
 * cheaper rate on every plan — an uncertain guess should not cost the merchant
 * money.
 */
export type ProductClass = "physical" | "digital";

/**
 * Classifies products in one round trip.
 *
 * Returns a map of `productId → class`. Ids that do not resolve to a product —
 * a deleted catalog row an old order still points at — are absent from the map,
 * and callers treat that as `physical` for the reason above.
 */
export async function classifyProducts(
  handle: DbHandle,
  productIds: (number | null | undefined)[],
): Promise<Map<number, ProductClass>> {
  const ids = [...new Set(productIds.filter((id): id is number => id != null))];
  const out = new Map<number, ProductClass>();
  if (ids.length === 0) return out;

  /** Membership-granting products are digital by definition (§18.9). */
  const rows = await handle
    .select({ id: products.id, grantsTierId: products.grantsTierId })
    .from(products)
    .where(inArray(products.id, ids));

  const withAssets = await handle
    .select({ productId: productDigitalAssets.productId })
    .from(productDigitalAssets)
    .where(inArray(productDigitalAssets.productId, ids));
  const delivers = new Set(withAssets.map((r) => r.productId));

  for (const row of rows) {
    out.set(row.id, row.grantsTierId != null || delivers.has(row.id) ? "digital" : "physical");
  }
  return out;
}

/** One line's contribution to the meter: net sales, per `docs/PRICING.md` §4.1. */
export type ClassifiableLine = {
  productId: number | null;
  subtotalMinor: number;
  discountMinor: number;
};

/**
 * Splits net sales across the two classes.
 *
 * Net sales is `subtotal − discounts` (§4.1), and this splits it **per line**
 * rather than apportioning the order total, because `order_lines.discountMinor`
 * is already allocated to sum back exactly to the order's own discount
 * (`lib/commerce/allocation.ts`). Re-apportioning would introduce a second
 * rounding step whose parts need not agree with the first.
 *
 * Returns whole minor units per class; the two always sum to the order's net
 * sales, so no money falls between the thresholds.
 */
export function splitNetSales(
  lines: ClassifiableLine[],
  classOf: Map<number, ProductClass>,
): Record<ProductClass, number> {
  const out: Record<ProductClass, number> = { physical: 0, digital: 0 };
  for (const line of lines) {
    const cls = (line.productId != null && classOf.get(line.productId)) || "physical";
    out[cls] += line.subtotalMinor - line.discountMinor;
  }
  return out;
}
