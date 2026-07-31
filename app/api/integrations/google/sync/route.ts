import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { ownSites } from "@/lib/tenancy";
import { db, products, sites } from "@/lib/db";
import { getIntegration, upsertIntegration } from "@/lib/integrations";
import { storefrontUrl } from "@/lib/queries";

/** Push live sites' enabled products to Google Merchant Center (Content API v2.1). */
export const POST = orgHandler(async (_req, { orgId }) => {
  const integration = await getIntegration(orgId, "google");
  if (integration?.status !== "connected" || !integration.config.serviceAccountJson) {
    throw badRequest("Google Merchant Center is not connected");
  }
  const merchantId = integration.config.merchantId;

  const liveSites = await db.select().from(sites).where(and(eq(sites.status, "live"), ownSites(orgId)));
  const siteById = new Map(liveSites.map((s) => [s.id, s]));
  const rows = liveSites.length
    ? await db
        .select()
        .from(products)
        .where(inArray(products.siteId, liveSites.map((s) => s.id)))
        .limit(50)
    : [];
  const enabled = rows.filter((p) => p.enabled);

  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(integration.config.serviceAccountJson),
    scopes: ["https://www.googleapis.com/auth/content"],
  });
  const content = google.content({ version: "v2.1", auth });

  let synced = 0;
  let failed = 0;
  for (const p of enabled) {
    const site = siteById.get(p.siteId)!;
    try {
      await content.products.insert({
        merchantId,
        requestBody: {
          offerId: `markii-${p.id}`,
          title: p.name,
          description: p.description ?? p.name,
          link: `${storefrontUrl(site)}/p/${p.slug}`,
          imageLink: p.images[0],
          contentLanguage: "en",
          targetCountry: "US",
          channel: "online",
          availability: p.stock > 0 ? "in stock" : "out of stock",
          condition: "new",
          price: { value: (p.priceCents / 100).toFixed(2), currency: p.currency },
        },
      });
      synced++;
    } catch (e) {
      console.error(`GMC sync failed for product ${p.id}`, e);
      failed++;
    }
  }

  await upsertIntegration(
    orgId,
    "google",
    failed > 0 && synced === 0 ? "error" : "connected",
    { ...integration.config, lastSyncAt: new Date().toISOString() },
    failed > 0 && synced === 0 ? "all product syncs failed — check credentials" : null,
  );

  return NextResponse.json({ synced, failed });
});
