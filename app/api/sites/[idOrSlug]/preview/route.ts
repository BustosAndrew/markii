import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { categories, db, products } from "@/lib/db";
import { bundleFromDb, generatePreview } from "@/lib/generators";
import { resolveSite } from "@/lib/queries";

export const GET = handler(async (_req, { params }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug);
  const cats = await db.select().from(categories).where(eq(categories.siteId, site.id));
  const prods = await db.select().from(products).where(eq(products.siteId, site.id));
  return NextResponse.json(generatePreview(bundleFromDb(site, cats, prods)));
});
