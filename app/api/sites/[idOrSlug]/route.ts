import { eq, ne, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { conflict, handler } from "@/lib/api";
import { db, sites } from "@/lib/db";
import { resolveSite, serializeSite } from "@/lib/queries";
import { siteUpdateSchema } from "@/lib/validation";

export const GET = handler(async (_req, { params }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug);
  return NextResponse.json(await serializeSite(site));
});

export const PATCH = handler(async (req, { params }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug);
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
  return NextResponse.json(await serializeSite(row));
});

export const DELETE = handler(async (_req, { params }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug);
  // categories/products/traffic cascade; orders keep a nulled site reference
  await db.delete(sites).where(eq(sites.id, site.id));
  return NextResponse.json({ deleted: true, id: site.id });
});
