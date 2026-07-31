import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { categories, db, products } from "@/lib/db";
import { bundleFromDb, generatePreview } from "@/lib/generators";
import { resolveSite } from "@/lib/queries";

export const GET = orgHandler(async (_req, { params, orgId }) => {
  const { idOrSlug } = await params;
  // Org-checked here, so the category/product reads below inherit the scope.
  const site = await resolveSite(idOrSlug, orgId);
  const cats = await db.select().from(categories).where(eq(categories.siteId, site.id));
  const prods = await db.select().from(products).where(eq(products.siteId, site.id));
  return NextResponse.json(generatePreview(bundleFromDb(site, cats, prods)));
});
