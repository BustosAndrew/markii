import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { db, sites } from "@/lib/db";
import { resolveSite, storefrontUrl } from "@/lib/queries";

export const POST = handler(async (_req, { params }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug);
  const [row] = await db
    .update(sites)
    .set({ status: "live", updatedAt: new Date() })
    .where(eq(sites.id, site.id))
    .returning();
  return NextResponse.json({ status: row.status, storefrontUrl: storefrontUrl(row) });
});
