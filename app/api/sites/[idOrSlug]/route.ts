import { eq, ne, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { conflict } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { invalidateCustomDomain } from "@/lib/domains";
import { resolveSite, serializeSite } from "@/lib/queries";
import { siteUpdateSchema } from "@/lib/validation";

export const GET = orgHandler(async (_req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  return NextResponse.json(await serializeSite(site));
});

export const PATCH = orgHandler(async (req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  const input = siteUpdateSchema.parse(await req.json());

  if (input.slug && input.slug !== site.slug) {
    const [taken] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.slug, input.slug), ne(sites.id, site.id)))
      .limit(1);
    if (taken) throw conflict(`site slug "${input.slug}" is already taken`);
  }

  const [row] = await db
    .update(sites)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(sites.id, site.id))
    .returning();

  // Both hosts: the old one must stop resolving as surely as the new one starts.
  if ("customDomain" in input) invalidateCustomDomain(site.customDomain, row.customDomain);

  return NextResponse.json(await serializeSite(row));
});

export const DELETE = orgHandler(async (_req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  // categories/products/traffic cascade; orders keep a nulled site reference
  await db.delete(sites).where(eq(sites.id, site.id));
  invalidateCustomDomain(site.customDomain);
  return NextResponse.json({ deleted: true, id: site.id });
});
