import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { resolveSite, storefrontUrl } from "@/lib/queries";

export const POST = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const [row] = await db
      .update(sites)
      .set({ status: "live", updatedAt: new Date() })
      .where(eq(sites.id, site.id))
      .returning();
    return NextResponse.json({ status: row.status, storefrontUrl: storefrontUrl(row) });
  },
  // Publishing a storefront is a write, and not one a viewer or analyst should make.
  { permission: "cms.write" },
);
