import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { levelsForVariants } from "@/lib/commerce/queries";
import { db, membershipTiers, productOptions, variants } from "@/lib/db";
import { productJson, READ_API_HEADERS, type StorefrontProductDetailJson } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/products/{slug}` on a storefront host (D53) — one enabled product
 * with its options and variants, the same reads the product page makes for its
 * variant picker, so a headless store can draw the same buy box.
 */
export const GET = handler(async (_req, { params }) => {
  const { site, slug } = await params;
  const data = await loadReadableSite(site);
  const product = data.prods.find((p) => p.slug === slug && p.enabled);
  if (!product) throw notFound("Product");

  const [options, variantRows] = await Promise.all([
    db.select().from(productOptions).where(eq(productOptions.productId, product.id)).orderBy(asc(productOptions.position)),
    db.select().from(variants).where(eq(variants.productId, product.id)).orderBy(asc(variants.position)),
  ]);
  const levels = await levelsForVariants(variantRows.map((v) => v.id));
  const [tier] = product.requiresTierId
    ? await db
        .select({ id: membershipTiers.id, name: membershipTiers.name })
        .from(membershipTiers)
        .where(and(eq(membershipTiers.id, product.requiresTierId), eq(membershipTiers.siteId, data.site.id)))
        .limit(1)
    : [];

  const body: StorefrontProductDetailJson = {
    ...productJson(data, product),
    requiresTier: tier ?? null,
    options: options.map((o) => ({ name: o.name, position: o.position, values: o.values })),
    variants: variantRows.map((v) => ({
      id: v.id,
      title: v.title,
      optionValues: v.optionValues,
      priceMinor: v.priceMinor,
      available: (levels.get(v.id) ?? []).reduce((sum, row) => sum + row.available, 0),
    })),
  };
  return NextResponse.json(body, { headers: READ_API_HEADERS });
});
