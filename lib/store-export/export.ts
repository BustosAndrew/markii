import { asc, getTableColumns, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import type { DbHandle } from "../db";
import { digitalAssets, productDigitalAssets } from "../db/schema";
import {
  SCHEMA_TAG,
  STORE_EXPORT_FILE_TTL_SECONDS,
  STORE_EXPORT_FORMAT,
  STORE_EXPORT_VERSION,
  type DigitalAssetFile,
  type StoreExportDocument,
} from "./format";
import { LEFT_OUT, STORE_TABLES, tableSpec, type Row, type StoreTable } from "./spec";

/**
 * Reads one store out of the database as a store export document (D53).
 *
 * Rows are selected with **subqueries, never id lists**: a variant is in the
 * export because `product_id in (select id from products where site_id = …)`,
 * so a store with a hundred thousand orders costs no more parameters than one
 * with ten — Postgres caps a statement at 65,535 of them, and a list of ids
 * would hit that on exactly the merchants who most need an export to work.
 *
 * Pure of server-only modules on purpose: storage is passed in, so the same
 * code is what an integration test drives.
 */

function column(spec: StoreTable, key: string): PgColumn {
  const col = getTableColumns(spec.table)[key];
  if (!col) throw new Error(`store export: ${spec.key} has no column ${key}`);
  return col as PgColumn;
}

function whereFor(spec: StoreTable, siteId: number): SQL {
  const scope = spec.scope;
  switch (scope.kind) {
    case "root":
      return sql`${column(spec, "id")} = ${siteId}`;
    case "site":
      return sql`${column(spec, scope.column)} = ${siteId}`;
    case "parent":
      return sql`${column(spec, scope.column)} in (${idsOf(scope.parent, siteId)})`;
    case "custom":
      if (spec.key === "digitalAssets") {
        return sql`(${digitalAssets.siteId} = ${siteId} or ${digitalAssets.id} in (select ${productDigitalAssets.assetId} from ${productDigitalAssets} where ${productDigitalAssets.productId} in (${idsOf("products", siteId)})))`;
      }
      throw new Error(`store export: no custom scope for ${spec.key}`);
  }
}

function idsOf(key: string, siteId: number): SQL {
  const spec = tableSpec(key);
  if (!spec) throw new Error(`store export: unknown table ${key}`);
  return sql`select ${column(spec, "id")} from ${spec.table} where ${whereFor(spec, siteId)}`;
}

/** Rows in a stable order, so two exports of an unchanged store hold the same document. */
function orderFor(spec: StoreTable) {
  const cols = getTableColumns(spec.table);
  if (cols.id) return [asc(cols.id)];
  const pk = getTableConfig(spec.table).primaryKeys[0]?.columns ?? [];
  if (pk.length) return pk.map((c) => asc(c));
  return Object.values(cols)
    .filter((c) => c.primary)
    .map((c) => asc(c));
}

export async function readStoreTables(db: DbHandle, siteId: number): Promise<Record<string, Row[]>> {
  const tables: Record<string, Row[]> = {};
  for (const spec of STORE_TABLES) {
    const rows = (await db
      .select()
      .from(spec.table)
      .where(whereFor(spec, siteId))
      .orderBy(...orderFor(spec))) as Row[];
    const omit = new Set(spec.omit ?? []);
    tables[spec.key] = rows.map((row) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(row)) if (!omit.has(k)) out[k] = v;
      return spec.scrub ? spec.scrub(out) : out;
    });
  }
  return tables;
}

/** Every string anywhere in a value, however deeply nested — design trees hold image URLs at any depth. */
export function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v);
  else if (value && typeof value === "object" && !(value instanceof Date)) for (const v of Object.values(value)) yield* stringsIn(v);
}

/**
 * The store's own public uploads, wherever a row mentions one: product images,
 * collection and category images, and design trees, custom HTML and theme
 * CSS. One scan over every string rather than a list of fields, so an image
 * field added later is carried without anyone remembering to add it — the
 * lesson `mapImages` already taught the theme package.
 */
export function publicMediaUrls(tables: Record<string, Row[]>, base: string | null): string[] {
  if (!base) return [];
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s"'()<>\\\\]+`, "g");
  const found = new Set<string>();
  for (const rows of Object.values(tables)) {
    for (const s of stringsIn(rows)) for (const m of s.matchAll(pattern)) found.add(m[0]);
  }
  return [...found].sort();
}

export async function buildStoreExport(input: {
  db: DbHandle;
  site: { id: number; slug: string; name: string };
  storeUrl: string;
  publicMediaBase: string | null;
  /** Signs a private file for {@link STORE_EXPORT_FILE_TTL_SECONDS}; null when it cannot. */
  signAsset: (storagePath: string, fileName: string) => Promise<string | null>;
  headCode: boolean;
  now?: Date;
}): Promise<{ doc: StoreExportDocument; unsigned: string[] }> {
  const now = input.now ?? new Date();
  const tables = await readStoreTables(input.db, input.site.id);

  // The storage path is this deployment's, so it stays out of the rows — the file travels by link.
  const assets: DigitalAssetFile[] = [];
  const unsigned: string[] = [];
  for (const row of tables.digitalAssets) {
    const path = String(row.storagePath);
    const url = await input.signAsset(path, String(row.fileName));
    if (!url) unsigned.push(String(row.fileName));
    else {
      assets.push({
        assetId: Number(row.id),
        fileName: String(row.fileName),
        contentType: String(row.contentType),
        sizeBytes: Number(row.sizeBytes),
        url,
      });
    }
    delete row.storagePath;
  }

  const counts = Object.fromEntries(STORE_TABLES.map((t) => [t.key, tables[t.key].length]));
  const doc: StoreExportDocument = {
    format: STORE_EXPORT_FORMAT,
    version: STORE_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    schema: SCHEMA_TAG,
    source: { siteId: input.site.id, slug: input.site.slug, name: input.site.name, storeUrl: input.storeUrl, publicMediaBase: input.publicMediaBase },
    leftOut: {
      tables: LEFT_OUT,
      columns: Object.fromEntries(
        STORE_TABLES.filter((t) => t.omit?.length).map((t) => [t.key, { columns: t.omit ?? [], reason: t.omitReason ?? null }]),
      ),
      headCode: input.headCode,
    },
    counts,
    tables,
    files: {
      expiresAt: new Date(now.getTime() + STORE_EXPORT_FILE_TTL_SECONDS * 1000).toISOString(),
      digitalAssets: assets,
      publicMedia: publicMediaUrls(tables, input.publicMediaBase).map((url) => ({ url })),
    },
  };
  return { doc, unsigned };
}
