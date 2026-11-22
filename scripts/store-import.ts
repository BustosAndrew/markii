/**
 * Imports a Markii store export into this deployment (D53).
 *
 * Run: `pnpm store:import <file.zip> --org <orgId> [--slug <address>] [--keep-image-links]`
 *
 * For a **self-hosted** Markii: the merchant exports their store from the
 * hosted one (`store.export`, owner or administrator, with a fresh second
 * factor), and the operator of the new deployment runs this. The org must
 * already exist — sign up on the new deployment first and pass its id
 * (`select id, name from organizations`).
 *
 * Writes directly, like `pnpm db:seed`: it restores history — orders,
 * refunds, ledger entries — that no registry action creates. All rows land in
 * one transaction or none do. The store arrives as a **draft**; going live,
 * connecting a payment rail and proving a custom domain are the merchant's,
 * in the dashboard, as on any new store.
 *
 * The storage client is built here, as in `ensure-buckets.ts`, because
 * `lib/storage` is `server-only`.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { db } from "../lib/db";
import { PRIVATE_BUCKET, PUBLIC_BUCKET } from "../lib/storage/buckets";
import { parseStoreExport } from "../lib/store-export/format";
import { importStore, StoreImportError } from "../lib/store-export/import";
import { unzip } from "../lib/zip";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

async function main() {
  const file = process.argv[2];
  const orgId = arg("org");
  if (!file || file.startsWith("--") || !orgId) {
    console.error("Usage: pnpm store:import <file.zip> --org <orgId> [--slug <address>] [--keep-image-links]");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("✖ Storage is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Sold files have nowhere to go.");
    process.exit(1);
  }
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let entries: Map<string, Buffer>;
  try {
    entries = unzip(readFileSync(file));
  } catch (err) {
    throw new StoreImportError(`Could not read ${file} as a zip: ${(err as Error).message}`);
  }
  const json = entries.get("store.json");
  if (!json) throw new StoreImportError("No store.json in this zip — is it a Markii store export?");
  const doc = parseStoreExport(json.toString("utf8"));
  console.log(`Importing "${doc.source.name}" (${doc.source.storeUrl}), exported ${doc.exportedAt}`);

  const report = await importStore({
    db,
    doc,
    orgId,
    slug: arg("slug"),
    copyImages: !process.argv.includes("--keep-image-links"),
    log: (line) => console.log(line),
    storage: {
      async putPrivate(path, bytes, contentType) {
        const { error } = await client.storage.from(PRIVATE_BUCKET).upload(path, bytes, { contentType });
        if (error) throw new StoreImportError(`Could not store a sold file: ${error.message}`);
      },
      async putPublic(path, bytes, contentType) {
        const { error } = await client.storage.from(PUBLIC_BUCKET).upload(path, bytes, { contentType });
        if (error) throw new Error(error.message);
        return client.storage.from(PUBLIC_BUCKET).getPublicUrl(path).data.publicUrl;
      },
    },
  });

  console.log(`✔ imported as store ${report.siteId} ("${report.slug}"), as a draft`);
  console.log(`  ${report.files.copied} sold file(s), ${report.images.copied} image(s) copied`);
  for (const img of report.images.leftAsLinks) console.log(`  ! image left as a link: ${img.url} (${img.reason})`);
  if (doc.leftOut.headCode) console.log("  ! the source store had custom scripts; add them again in the Theme tab");
  console.log("  Next: connect a payment rail, verify a domain, and set the store live in the dashboard.");
  process.exit(0);
}

main().catch((e) => {
  // A refusal is a sentence for the operator; anything else is a bug and keeps its stack.
  console.error(e instanceof StoreImportError ? `✖ ${e.message}\n  Nothing was imported.` : e);
  process.exit(1);
});
