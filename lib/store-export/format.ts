import { z } from "zod";
import journal from "../../drizzle/meta/_journal.json";
import type { Row } from "./spec";

/**
 * The store export file (D53): `{slug}-store.zip` holding `store.json` (this
 * document) and a `README.md`. Unlike a theme package — portable to any store,
 * and so never carrying store data — this is **one store, whole**: catalogue,
 * customers, orders, files and design, for a self-hosted Markii to import.
 *
 * It contains customers' personal data and the merchant's sold files' download
 * links, which is why the action that makes one is owner/administrator only,
 * a person only, and asks for a fresh second factor.
 */

/** A refusal worded for the person importing: what is wrong, and what to do. */
export class StoreImportError extends Error {}

export const STORE_EXPORT_FORMAT = "markii.store";
export const STORE_EXPORT_VERSION = 1;

/** How long the links to the store's sold files inside an export stay valid. */
export const STORE_EXPORT_FILE_TTL_SECONDS = 24 * 60 * 60;

/**
 * The newest migration this code knows. An export records the one it was made
 * under, and an importer **older** than that refuses: rows from a newer schema
 * may carry columns it would drop. An older export into a newer schema is fine
 * — columns added since take their defaults.
 */
export const SCHEMA_TAG: string = journal.entries[journal.entries.length - 1].tag;

export function schemaIndex(tag: string): number {
  return journal.entries.findIndex((e) => e.tag === tag);
}

export type DigitalAssetFile = {
  /** The asset's id in the export — `tables.digitalAssets[].id`. */
  assetId: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Signed, valid until `files.expiresAt`. Fetch it; it needs no credential. */
  url: string;
};

export type PublicMediaFile = {
  /** The address as it appears in rows — the importer replaces it wherever it occurs. */
  url: string;
};

export type StoreExportDocument = {
  format: typeof STORE_EXPORT_FORMAT;
  version: typeof STORE_EXPORT_VERSION;
  exportedAt: string;
  schema: string;
  source: { siteId: number; slug: string; name: string; storeUrl: string; publicMediaBase: string | null };
  /** What did not come, said once here rather than discovered later. */
  leftOut: { tables: Record<string, string>; columns: Record<string, { columns: string[]; reason: string | null }>; headCode: boolean };
  counts: Record<string, number>;
  tables: Record<string, Row[]>;
  files: { expiresAt: string; digitalAssets: DigitalAssetFile[]; publicMedia: PublicMediaFile[] };
};

const header = z.object({
  format: z.literal(STORE_EXPORT_FORMAT),
  version: z.literal(STORE_EXPORT_VERSION),
  exportedAt: z.string(),
  schema: z.string(),
  source: z.object({ siteId: z.number(), slug: z.string(), name: z.string(), storeUrl: z.string(), publicMediaBase: z.string().nullable() }),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  files: z.object({
    expiresAt: z.string(),
    digitalAssets: z.array(z.object({ assetId: z.number(), fileName: z.string(), contentType: z.string(), sizeBytes: z.number(), url: z.string().url() })),
    publicMedia: z.array(z.object({ url: z.string().url() })),
  }),
});

/**
 * Reads `store.json` and checks it is something this code can import. The
 * rows themselves are checked by Postgres on insert — every constraint the
 * schema has applies to an import exactly as to any other write.
 */
export function parseStoreExport(text: string): StoreExportDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StoreImportError("store.json is not valid JSON.");
  }
  const formatOnly = z.object({ format: z.string().optional(), version: z.unknown().optional() }).safeParse(raw);
  if (!formatOnly.success || formatOnly.data.format !== STORE_EXPORT_FORMAT) {
    throw new StoreImportError(`This is not a Markii store export (format "${STORE_EXPORT_FORMAT}").`);
  }
  if (formatOnly.data.version !== STORE_EXPORT_VERSION) {
    throw new StoreImportError(`This store export is version ${String(formatOnly.data.version)}; this Markii reads version ${STORE_EXPORT_VERSION}.`);
  }
  const parsed = header.safeParse(raw);
  if (!parsed.success) throw new StoreImportError(`store.json is damaged: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const at = schemaIndex(parsed.data.schema);
  if (at < 0) {
    throw new StoreImportError(`This export was made under migration ${parsed.data.schema}, which this Markii does not have. Upgrade, run pnpm db:migrate, and import again.`);
  }
  return raw as StoreExportDocument;
}

export function storeExportReadme(doc: Pick<StoreExportDocument, "source" | "exportedAt" | "counts" | "files" | "leftOut">): string {
  const counts = Object.entries(doc.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `- ${k}: ${n}`)
    .join("\n");
  const left = Object.entries(doc.leftOut.columns)
    .filter(([, v]) => v.reason)
    .map(([k, v]) => `- **${k}** — ${v.reason}`)
    .join("\n");
  return `# ${doc.source.name} — Markii store export

Exported ${doc.exportedAt} from ${doc.source.storeUrl}.

**This file holds your customers' personal data** — names, emails, addresses, order history —
and links to download the files you sell. Keep it as you would a database backup, and delete it
once it is imported.

## What is in it

${counts || "- (an empty store)"}

The links to your sold files expire at **${doc.files.expiresAt}**. Import before then, or export
again for fresh ones. Product and design images are public links and do not expire.

## Importing into a self-hosted Markii

\`\`\`bash
pnpm db:migrate
pnpm store:import ./${doc.source.slug}-store.zip --org <your org id> [--slug ${doc.source.slug}]
\`\`\`

The store arrives as a **draft**. It copies your sold files and images into that deployment's own
storage, keeps every id relationship, and refuses rather than half-importing.

## What does not come with it

${left}
${doc.leftOut.headCode ? "- **Your custom scripts** — this store has some, and scripts never travel with a design. Add them again in the Theme tab.\n" : ""}- Staff, API tokens, storefront keys and integrations — credentials stay where they were made.
- The audit log, analytics, and Markii's billing records.

## Subscriptions on your Stripe account

Recurring memberships are subscriptions on **your own** Stripe account and keep billing. Renewals
reach whichever Markii your Stripe account is connected to, so connect it to the new deployment
and disconnect it here when you switch over.
`;
}
