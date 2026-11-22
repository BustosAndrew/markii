import { randomUUID } from "node:crypto";
import { eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { DbHandle } from "../db";
import { customerMemberships, downloadGrants, organizations, sites } from "../db/schema";
import { StoreImportError, type StoreExportDocument } from "./format";
import { STORE_TABLES, type IdMaps, type Row, type StoreTable } from "./spec";

/**
 * Imports a store export into this deployment (D53) — the self-hosted half.
 *
 * **All or nothing.** Files are copied first, because storage is not part of
 * a transaction; then every row goes in inside one transaction, so a refusal
 * at row 40,000 leaves no half-store behind (copied files are left at fresh
 * random paths, unreferenced — a retry copies again rather than guessing).
 *
 * **Ids are allocated before anything is written** (`nextval` per table), so
 * every map is complete before the first insert: ids inside JSON (suggested
 * products, discount targets, version snapshots) and self-references
 * (category parents) remap as easily as ordinary foreign keys, and nothing
 * depends on `RETURNING` coming back in insertion order.
 *
 * Foreign keys are found from Drizzle's own metadata, never listed by hand.
 * One that points at a row the export does not hold becomes null when the
 * column allows it and refuses the import when it does not — a wrong link is
 * worse than a missing one.
 *
 * **Runs as the deployment's operator, from a shell** (`pnpm store:import`),
 * like a seed or a migration: it writes rows directly rather than through the
 * registry, because it is restoring history (orders, refunds, ledger entries)
 * that no action creates, and there is no merchant session on the other side
 * to authorize it as.
 */

export type ImportStorage = {
  putPrivate(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Returns the file's public address. */
  putPublic(path: string, bytes: Uint8Array, contentType: string): Promise<string>;
};

export type ImportReport = {
  siteId: number;
  slug: string;
  counts: Record<string, number>;
  files: { copied: number; bytes: number };
  images: { copied: number; leftAsLinks: { url: string; reason: string }[] };
};

export { StoreImportError };

const extOf = (name: string) => {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name);
  return m ? `.${m[1].toLowerCase()}` : "";
};

async function fetchBytes(fetcher: typeof fetch, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

/** Column property name ↔ column, and which property each column object is. */
function columnsOf(table: PgTable) {
  const byKey = getTableColumns(table) as Record<string, PgColumn>;
  const keyOf = new Map<PgColumn, string>();
  for (const [k, c] of Object.entries(byKey)) keyOf.set(c, k);
  return { byKey, keyOf };
}

type ForeignKey = { column: string; nullable: boolean; target: "org" | "self" | string | null };

function foreignKeys(spec: StoreTable, specOf: Map<PgTable, string>): ForeignKey[] {
  const { byKey, keyOf } = columnsOf(spec.table);
  return getTableConfig(spec.table).foreignKeys.map((fk) => {
    const ref = fk.reference();
    if (ref.columns.length !== 1) throw new StoreImportError(`${spec.key}: composite foreign keys are not supported`);
    const column = keyOf.get(ref.columns[0] as PgColumn);
    if (!column) throw new StoreImportError(`${spec.key}: unknown foreign key column`);
    const target =
      ref.foreignTable === organizations
        ? "org"
        : ref.foreignTable === spec.table
          ? "self"
          : (specOf.get(ref.foreignTable) ?? null);
    return { column, nullable: !byKey[column].notNull, target };
  });
}

function hasSerialId(table: PgTable): boolean {
  const id = getTableColumns(table).id as PgColumn | undefined;
  return Boolean(id && id.columnType === "PgSerial");
}

/** Replaces every exported public-media address in a value with its copy here. */
function rewriteUrls(value: unknown, swap: (s: string) => string): unknown {
  if (typeof value === "string") return swap(value);
  if (Array.isArray(value)) return value.map((v) => rewriteUrls(v, swap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteUrls(v, swap);
    return out;
  }
  return value;
}

export async function importStore(input: {
  db: DbHandle;
  doc: StoreExportDocument;
  orgId: string;
  slug?: string;
  storage: ImportStorage;
  /** Copy the store's public images here. Off leaves them pointing at the source deployment. */
  copyImages?: boolean;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}): Promise<ImportReport> {
  const { db, doc, orgId } = input;
  const fetcher = input.fetcher ?? fetch;
  const log = input.log ?? (() => {});
  const slug = (input.slug ?? doc.source.slug).toLowerCase();
  const tables = doc.tables;
  const rowsOf = (key: string) => tables[key] ?? [];

  // --- Preflight: refuse before copying a byte -----------------------------
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new StoreImportError(`No organization ${orgId} on this deployment.`);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) throw new StoreImportError(`"${slug}" is not a valid store address.`);
  const [taken] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1);
  if (taken) throw new StoreImportError(`The address "${slug}" is taken here. Choose another with --slug.`);
  if (rowsOf("sites").length !== 1) throw new StoreImportError("The export does not hold exactly one store.");

  // Unique across the whole deployment, so they collide when the source store is still in this database.
  const tokens = rowsOf("downloadGrants").map((r) => String(r.token));
  if (tokens.length && (await db.select({ id: downloadGrants.id }).from(downloadGrants).where(inArray(downloadGrants.token, tokens.slice(0, 10_000))).limit(1)).length) {
    throw new StoreImportError("Download links in this export already exist here — is the source store in this same database?");
  }
  const subs = rowsOf("customerMemberships").flatMap((r) => (r.stripeSubscriptionId ? [String(r.stripeSubscriptionId)] : []));
  if (subs.length && (await db.select({ id: customerMemberships.id }).from(customerMemberships).where(inArray(customerMemberships.stripeSubscriptionId, subs.slice(0, 10_000))).limit(1)).length) {
    throw new StoreImportError("Subscriptions in this export are already attached to memberships here — is the source store in this same database?");
  }

  const filesFor = new Map(doc.files.digitalAssets.map((f) => [f.assetId, f]));
  const missing = rowsOf("digitalAssets").filter((r) => !filesFor.has(Number(r.id)));
  if (missing.length) {
    throw new StoreImportError(`The export lists ${missing.length} sold file(s) with no download link (${missing.map((r) => r.fileName).join(", ")}). Export again.`);
  }
  if (doc.files.digitalAssets.length && Date.parse(doc.files.expiresAt) < Date.now()) {
    throw new StoreImportError(`The links to this store's sold files expired at ${doc.files.expiresAt}. Export again for fresh ones.`);
  }

  // --- Files: sold files must all arrive; images may stay as links --------
  const assetPath = new Map<number, string>();
  let fileBytes = 0;
  for (const f of doc.files.digitalAssets) {
    let got: { bytes: Uint8Array; contentType: string };
    try {
      got = await fetchBytes(fetcher, f.url);
    } catch (err) {
      throw new StoreImportError(`Could not download ${f.fileName}: ${(err as Error).message}`);
    }
    if (got.bytes.byteLength !== f.sizeBytes) {
      throw new StoreImportError(`${f.fileName} arrived as ${got.bytes.byteLength} bytes, not ${f.sizeBytes}. Export again.`);
    }
    const path = `${orgId}/${randomUUID()}${extOf(f.fileName)}`;
    await input.storage.putPrivate(path, got.bytes, f.contentType);
    assetPath.set(f.assetId, path);
    fileBytes += got.bytes.byteLength;
    log(`  file  ${f.fileName} (${got.bytes.byteLength} bytes)`);
  }

  const urlSwap = new Map<string, string>();
  const leftAsLinks: { url: string; reason: string }[] = [];
  if (input.copyImages ?? true) {
    for (const { url } of doc.files.publicMedia) {
      try {
        const got = await fetchBytes(fetcher, url);
        const path = `${orgId}/${randomUUID()}${extOf(new URL(url).pathname)}`;
        urlSwap.set(url, await input.storage.putPublic(path, got.bytes, got.contentType));
      } catch (err) {
        leftAsLinks.push({ url, reason: (err as Error).message });
      }
    }
    log(`  images  ${urlSwap.size} copied, ${leftAsLinks.length} left as links`);
  } else {
    for (const { url } of doc.files.publicMedia) leftAsLinks.push({ url, reason: "not copied (--keep-image-links)" });
  }
  const base = doc.source.publicMediaBase;
  const pattern = base
    ? new RegExp(`${(base.endsWith("/") ? base : `${base}/`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s"'()<>\\\\]+`, "g")
    : null;
  const swap = (s: string) => (pattern && urlSwap.size ? s.replace(pattern, (m) => urlSwap.get(m) ?? m) : s);

  // --- Rows, in one transaction --------------------------------------------
  const specOf = new Map<PgTable, string>(STORE_TABLES.map((t) => [t.table, t.key]));
  const run = async (tx: DbHandle): Promise<number> => {
    const ids: IdMaps = new Map();
    for (const spec of STORE_TABLES) {
      const rows = rowsOf(spec.key);
      if (!hasSerialId(spec.table) || rows.length === 0) continue;
      const { name } = getTableConfig(spec.table);
      const allocated = (await tx.execute(
        sql`select nextval(pg_get_serial_sequence(${`"${name}"`}, 'id'))::int as id from generate_series(1, ${rows.length})`,
      )) as unknown as { id: number }[];
      ids.set(spec.key, new Map(rows.map((r, i) => [Number(r.id), Number(allocated[i].id)])));
    }

    for (const spec of STORE_TABLES) {
      const rows = rowsOf(spec.key);
      if (rows.length === 0) continue;
      const { byKey } = columnsOf(spec.table);
      const fks = foreignKeys(spec, specOf);
      const own = ids.get(spec.key);
      const selfLinks: { id: number; column: string; to: number }[] = [];

      const prepared = rows.map((source) => {
        for (const k of Object.keys(source)) {
          if (!byKey[k]) throw new StoreImportError(`${spec.key}.${k} is not a column on this deployment. Is it older than the export?`);
        }
        let row: Row = { ...source };
        for (const k of spec.omit ?? []) delete row[k];
        // Again on the way in: a file can be edited by hand, and what may not leave may not arrive either.
        if (spec.scrub) row = spec.scrub(row);
        if (spec.remap) row = spec.remap(row, ids);

        for (const fk of fks) {
          if (fk.target === "org") {
            row[fk.column] = orgId;
            continue;
          }
          const value = row[fk.column];
          if (value === null || value === undefined) continue;
          const map = fk.target === "self" ? own : fk.target ? ids.get(fk.target) : undefined;
          const next = map?.get(Number(value));
          if (next === undefined) {
            if (!fk.nullable) {
              throw new StoreImportError(`${spec.key}.${fk.column} points at ${String(value)}, which the export does not hold.`);
            }
            row[fk.column] = null;
          } else if (fk.target === "self") {
            row[fk.column] = null;
            selfLinks.push({ id: own!.get(Number(source.id))!, column: fk.column, to: next });
          } else {
            row[fk.column] = next;
          }
        }

        if (own) row.id = own.get(Number(source.id));
        if (spec.key === "sites") row.slug = slug;
        if (spec.key === "digitalAssets") row.storagePath = assetPath.get(Number(source.id));

        for (const [k, col] of Object.entries(byKey)) {
          const v = row[k];
          if (col.columnType === "PgTimestamp" && typeof v === "string") row[k] = new Date(v);
          else if (typeof v === "string" || (v && typeof v === "object")) row[k] = rewriteUrls(v, swap);
        }
        return row;
      });

      for (let i = 0; i < prepared.length; i += 500) {
        await tx.insert(spec.table).values(prepared.slice(i, i + 500) as never);
      }
      for (const link of selfLinks) {
        const idCol = byKey.id;
        await tx.update(spec.table).set({ [link.column]: link.to } as never).where(eq(idCol, link.id));
      }
      log(`  rows  ${spec.key}: ${prepared.length}`);
    }
    return ids.get("sites")!.get(Number(rowsOf("sites")[0].id))!;
  };

  const siteId = await db.transaction((tx) => run(tx as DbHandle));

  return {
    siteId,
    slug,
    counts: Object.fromEntries(STORE_TABLES.map((t) => [t.key, rowsOf(t.key).length])),
    files: { copied: assetPath.size, bytes: fileBytes },
    images: { copied: urlSwap.size, leftAsLinks },
  };
}
