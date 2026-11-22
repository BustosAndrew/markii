import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, notFound } from "../../api";
import { siteDesigns, sites } from "../../db";
import { storefrontUrl } from "../../queries";
import { PRIVATE_BUCKET, publicMediaUrl, signedDownloadUrl, uploadFile } from "../../storage";
import { buildStoreExport } from "../../store-export/export";
import { STORE_EXPORT_FILE_TTL_SECONDS, storeExportReadme } from "../../store-export/format";
import { ownSites } from "../../tenancy";
import { zip } from "../../zip";
import { defineAction } from "../registry";

/**
 * Export one store whole — catalogue, customers, orders, files, design — for a
 * self-hosted Markii to import (D53). The format and what it leaves out are in
 * `lib/store-export/`.
 *
 * **An action, though it changes nothing.** Reads are not registry actions as
 * a rule (the MCP read tools are plain `GET`s), but this one hands every
 * customer's personal data to whoever asks, and three things only the
 * registry gives are what make that acceptable: an audit row naming the
 * person, step-up (a fresh second factor — the unattended laptop is the
 * threat), and `high`, which no token or agent can execute.
 *
 * The archive is written to private storage — the same one path per store, so
 * at most one copy rests there — and handed back as a five-minute link. The
 * link is redacted from the audit row: it is a bearer credential for the file.
 */

export type StoreExportResult = {
  url: string;
  expiresAt: string;
  bytes: number;
  counts: Record<string, number>;
  files: { digitalAssets: number; publicMedia: number; linksExpireAt: string };
  headCodeLeftOut: boolean;
};

export const exportStore = defineAction({
  id: "store.export",
  description:
    "Export one store whole — products, variants, inventory, collections, customers and their " +
    "addresses and memberships, orders with refunds and fulfillments, discounts, shipping, tax " +
    "settings, sold files and the design — as a zip a self-hosted Markii imports. Contains " +
    "customers' personal data. Returns a five-minute download link. A person must do this.",
  input: z.object({ siteId: z.number().int().positive() }).strict(),
  permission: "store.export",
  riskTier: "high",
  requiresStepUp: true,
  undoable: false,
  redactResult: (result) => ({ ...(result as Record<string, unknown>), url: "[five-minute link — not stored]" }),
  async run(input, ctx): Promise<StoreExportResult> {
    if (!ctx.actor.orgId) throw notFound("Site");
    const orgId = ctx.actor.orgId;
    const [site] = await ctx.db
      .select()
      .from(sites)
      .where(and(eq(sites.id, input.siteId), ownSites(orgId)))
      .limit(1);
    if (!site) throw notFound("Site");
    const [design] = await ctx.db
      .select({ draft: siteDesigns.draftHeadHtml, published: siteDesigns.publishedHeadHtml })
      .from(siteDesigns)
      .where(eq(siteDesigns.siteId, site.id))
      .limit(1);

    const { doc, unsigned } = await buildStoreExport({
      db: ctx.db,
      site,
      storeUrl: storefrontUrl(site),
      publicMediaBase: publicMediaUrl(""),
      // A dry run reaches no further than the database.
      signAsset: async (path, fileName) => {
        if (ctx.dryRun) return "https://dry-run.invalid/";
        const link = await signedDownloadUrl({ path, ttlSeconds: STORE_EXPORT_FILE_TTL_SECONDS, downloadAs: fileName });
        return link.ok ? link.url : null;
      },
      headCode: Boolean(design && (design.draft || design.published)),
    });
    if (unsigned.length) {
      // An export missing a sold file is not the store; refuse rather than hand over most of it.
      throw new ApiError("UPSTREAM_ERROR", 502, `Could not make download links for: ${unsigned.join(", ")}. Try again.`, { reason: "sign_failed" });
    }

    const summary = {
      counts: doc.counts,
      files: { digitalAssets: doc.files.digitalAssets.length, publicMedia: doc.files.publicMedia.length, linksExpireAt: doc.files.expiresAt },
      headCodeLeftOut: doc.leftOut.headCode,
    };
    if (ctx.dryRun) return { url: "", expiresAt: "", bytes: 0, ...summary };

    const archive = zip([
      { path: "store.json", data: JSON.stringify(doc) },
      { path: "README.md", data: storeExportReadme(doc) },
    ]);
    const path = `${orgId}/store-exports/${site.id}.zip`;
    const stored = await uploadFile({ bucket: PRIVATE_BUCKET, path, body: archive, contentType: "application/zip", upsert: true });
    if (!stored.ok) {
      throw new ApiError(
        stored.code === "configuration_required" ? "CONFIGURATION_REQUIRED" : "UPSTREAM_ERROR",
        stored.code === "configuration_required" ? 503 : 502,
        "The export could not be stored for download.",
        { reason: stored.code },
      );
    }
    const link = await signedDownloadUrl({ path, downloadAs: `${site.slug}-store.zip` });
    if (!link.ok) throw new ApiError("UPSTREAM_ERROR", 502, "The export was stored but no download link could be made. Try again.", { reason: link.code });

    ctx.recordDiff({ entity: "site", entityId: String(site.id), path: "exported", before: null, after: { bytes: archive.length, ...summary.files } });
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), bytes: archive.length, ...summary };
  },
});
