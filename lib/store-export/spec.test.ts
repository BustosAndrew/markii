import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { organizations } from "../db/schema";
import { publicMediaUrls } from "./export";
import { LEFT_OUT, STORE_TABLES, schemaTables, tableSpec, type IdMaps } from "./spec";

/**
 * The store export's promises, held structurally (D53). These are the tests
 * that fail when someone adds a table, a foreign key or a column and does not
 * decide what a store export does with it.
 */
describe("store export spec", () => {
  const tables = schemaTables();
  const keyOf = new Map([...tables].map(([k, t]) => [t, k]));

  it("classifies every table in the schema exactly once — exported, or left out with a reason", () => {
    const exported = STORE_TABLES.map((t) => t.key);
    const left = Object.keys(LEFT_OUT);
    expect(new Set(exported).size).toBe(exported.length);
    expect(exported.filter((k) => left.includes(k))).toEqual([]);
    const unclassified = [...tables.keys()].filter((k) => !exported.includes(k) && !left.includes(k));
    expect(unclassified, "add the new table to STORE_TABLES or LEFT_OUT").toEqual([]);
    expect([...exported, ...left].filter((k) => !tables.has(k))).toEqual([]);
    for (const [k, reason] of Object.entries(LEFT_OUT)) expect(reason.length, k).toBeGreaterThan(10);
    for (const t of STORE_TABLES) expect(tables.get(t.key), t.key).toBe(t.table);
  });

  it("lists tables in an order every foreign key can be inserted in", () => {
    STORE_TABLES.forEach((spec, i) => {
      const earlier = new Set(STORE_TABLES.slice(0, i + 1).map((t) => t.table));
      for (const fk of getTableConfig(spec.table).foreignKeys) {
        const target = fk.reference().foreignTable;
        if (target === organizations) continue;
        const name = keyOf.get(target) ?? "?";
        if (LEFT_OUT[name]) {
          // A link into a table that stays behind must be droppable.
          const col = fk.reference().columns[0] as PgColumn;
          expect(col.notNull, `${spec.key} → ${name} is NOT NULL but ${name} is left out`).toBe(false);
          continue;
        }
        expect(earlier.has(target), `${spec.key} references ${name}, which comes later`).toBe(true);
      }
    });
  });

  it("scopes every table to the store through a table earlier in the list", () => {
    STORE_TABLES.forEach((spec, i) => {
      const s = spec.scope;
      if (s.kind === "parent") {
        expect(STORE_TABLES.slice(0, i).some((t) => t.key === s.parent), `${spec.key} → ${s.parent}`).toBe(true);
        expect(getTableColumns(spec.table)[s.column], `${spec.key}.${s.column}`).toBeDefined();
        expect(getTableColumns(tableSpec(s.parent)!.table).id, `${s.parent}.id`).toBeDefined();
      }
      if (s.kind === "site") expect(getTableColumns(spec.table)[s.column], `${spec.key}.${s.column}`).toBeDefined();
      if (s.kind === "root") expect(spec.key).toBe("sites");
    });
  });

  it("omits only columns that exist, and never a NOT NULL column without a default", () => {
    for (const spec of STORE_TABLES) {
      const cols = getTableColumns(spec.table) as Record<string, PgColumn>;
      for (const k of spec.omit ?? []) {
        expect(cols[k], `${spec.key}.${k}`).toBeDefined();
        const col = cols[k];
        // orgId is filled by the importer; everything else must fall back to a default or null.
        if (k !== "orgId") expect(!col.notNull || col.hasDefault || Boolean(col.generated), `${spec.key}.${k}`).toBe(true);
      }
    }
  });

  it("never carries a credential, a login, or custom scripts", () => {
    const omitted = (key: string) => tableSpec(key)?.omit ?? [];
    expect(omitted("customers")).toContain("authUserId");
    expect(omitted("siteDesigns")).toEqual(expect.arrayContaining(["draftHeadHtml", "publishedHeadHtml"]));
    expect(omitted("sites")).toEqual(expect.arrayContaining(["walletAddress", "paymentProviders", "domainVerificationToken"]));
    for (const k of ["apiTokens", "storefrontKeys", "integrations", "mfaRecoveryCodes", "staff"]) expect(LEFT_OUT[k], k).toBeDefined();
  });

  it("remaps ids that live inside JSON, and drops ones that point outside the store", () => {
    const ids: IdMaps = new Map([
      ["products", new Map([[1, 101], [2, 102]])],
      ["collections", new Map([[7, 707]])],
      ["customers", new Map([[5, 505]])],
      ["siteDocuments", new Map([[9, 909]])],
    ]);
    const product = tableSpec("products")!.remap!(
      { suggestedProductIds: [2, 99], addOns: [{ productId: 1, mandatory: true }, { productId: 98, mandatory: false }] },
      ids,
    );
    expect(product).toMatchObject({ suggestedProductIds: [102], addOns: [{ productId: 101, mandatory: true }] });

    const discount = tableSpec("discounts")!.remap!;
    expect(discount({ appliesToScope: "collections", appliesToIds: [7], eligibleCustomerIds: [5, 6] }, ids)).toMatchObject({
      appliesToIds: [707],
      eligibleCustomerIds: [505],
    });
    expect(discount({ appliesToScope: "products", appliesToIds: [1, 7], eligibleCustomerIds: [] }, ids)).toMatchObject({ appliesToIds: [101] });

    const versions = tableSpec("siteDesignVersions")!;
    const exported = versions.scrub!({ snapshot: { themeId: "studio", headHtml: "<script>x</script>", documents: [{ id: 9 }, { id: 4 }] } });
    // Scrubbed on the way out, so the file itself never holds a past version's scripts.
    expect(JSON.stringify(exported)).not.toContain("<script>");
    expect(versions.remap!(exported, ids).snapshot).toEqual({ themeId: "studio", documents: [{ id: 909 }, { id: -2 }] });
  });

  it("finds the store's own uploads anywhere in a row — and nothing else", () => {
    const base = "https://x.supabase.co/storage/v1/object/public/public-media";
    const urls = publicMediaUrls(
      {
        products: [{ images: [`${base}/o/a.png`, "https://elsewhere.com/b.png"] }],
        siteDocuments: [{ draftTree: { children: [{ props: { html: `<img src="${base}/o/c.jpg">` } }] } }],
        siteDesigns: [{ draftCustomCss: `body{background:url(${base}/o/d.webp)}` }],
      },
      base,
    );
    expect(urls).toEqual([`${base}/o/a.png`, `${base}/o/c.jpg`, `${base}/o/d.webp`]);
    expect(publicMediaUrls({ products: [{ images: [`${base}/o/a.png`] }] }, null)).toEqual([]);
  });
});
