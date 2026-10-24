import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Import commit (§5) against a real database. The parsing is unit-tested
 * (`lib/importer.test.ts`); what only this can show is the wiring — that a
 * staged product's variants really land, through the registry, as the person
 * committing, and that the commit refuses what the parser would have refused.
 */
describe("import commit", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let siteId: number;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "import");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    siteId = (await createTestStore(cleanup, "import", { orgId })).site.id;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  const stamp = Date.now();

  it("builds a staged product's variants in one audited invocation", async () => {
    const res = await merchant.post("/api/import/commit", {
      items: [
        {
          tempId: "imp_1",
          name: "Imported Tee",
          slug: `imported-tee-${stamp}`,
          priceCents: 2000,
          currency: "EUR",
          stock: 0,
          stockKnown: false,
          options: [
            { name: "Size", values: ["S", "M"] },
            { name: "Colour", values: ["Red", "Blue"] },
          ],
          variants: [
            { optionValues: { Size: "S", Colour: "Red" }, priceCents: 2000, sku: `S-R-${stamp}` },
            { optionValues: { Size: "M", Colour: "Blue" }, priceCents: 2250, compareAtCents: 3000, sku: `M-B-${stamp}` },
          ],
        },
      ],
      categories: [],
      allocations: [{ tempId: "imp_1", siteId }],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.failed).toEqual([]);
    const productId = res.json.createdProducts[0].id;

    const rows = await sql`select option_values, price_minor, compare_at_minor, sku
                           from variants where product_id = ${productId}`;
    expect(rows).toHaveLength(4); // the full 2×2 grid
    const mb = rows.find((r) => r.option_values.Size === "M" && r.option_values.Colour === "Blue");
    expect(mb).toMatchObject({ price_minor: 2250, compare_at_minor: 3000, sku: `M-B-${stamp}` });
    const sr = rows.find((r) => r.option_values.Size === "S" && r.option_values.Colour === "Red");
    expect(sr).toMatchObject({ price_minor: 2000, sku: `S-R-${stamp}` });

    // Two cells the source never sold: reported, not hidden.
    expect(res.json.warnings[0]).toMatchObject({ code: "EXTRA_VARIANTS", tempIds: ["imp_1"] });
    expect(res.json.warnings[0].message).toMatch(/^2 option combination/);

    // One registry invocation, as the person committing — not one per variant.
    const audits = await sql`select actor_type, ok from action_invocations
                             where org_id = ${orgId} and action_id = 'catalog.setProductOptions'`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: "user", ok: true });
  });

  /**
   * Provenance is stored, and a second run of the same import recognises the
   * product by the source's own id — even when the slug has changed since.
   */
  it("records where a product came from and refuses to import it twice", async () => {
    const item = {
      tempId: "imp_p",
      name: "Sourced Mug",
      slug: `sourced-mug-${stamp}`,
      priceCents: 1500,
      currency: "USD",
      source: "shopify",
      sourceId: `src-${stamp}`,
      sourceUrl: "https://shop.test/products/sourced-mug",
    };
    const first = await merchant.post("/api/import/commit", {
      items: [item],
      categories: [],
      allocations: [{ tempId: "imp_p", siteId }],
    });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const created = first.json.createdProducts[0];
    expect(created).toMatchObject({
      importSource: "shopify",
      importSourceId: `src-${stamp}`,
      importSourceUrl: "https://shop.test/products/sourced-mug",
    });
    expect(created.importedAt).toBeTruthy();

    const again = await merchant.post("/api/import/commit", {
      items: [{ ...item, slug: `renamed-mug-${stamp}` }],
      categories: [],
      allocations: [{ tempId: "imp_p", siteId }],
    });
    expect(again.status).toBe(201);
    expect(again.json.createdProducts).toEqual([]);
    expect(again.json.failed[0].reason).toMatch(new RegExp(`already imported .*#${created.id}`));
  });

  /** Provenance is written by the import commit alone; editing a product cannot set it. */
  it("does not let a product edit claim an import source", async () => {
    const [made] = await sql`select id from products where site_id = ${siteId} and import_source is null limit 1`;
    const res = await merchant.patch(`/api/products/${made.id}`, { importSource: "shopify", importSourceId: "x" });
    expect([200, 400]).toContain(res.status);
    const [row] = await sql`select import_source, import_source_id from products where id = ${made.id}`;
    expect(row).toEqual({ import_source: null, import_source_id: null });
  });

  /** A yen product would display one price and charge another; the commit refuses it too. */
  it("refuses an item in a currency without two decimals, even when sent directly", async () => {
    const res = await merchant.post("/api/import/commit", {
      items: [{ tempId: "imp_y", name: "Yen Bowl", slug: `yen-bowl-${stamp}`, priceCents: 150000, currency: "JPY" }],
      categories: [],
      allocations: [{ tempId: "imp_y", siteId }],
    });
    expect(res.status).toBe(201);
    expect(res.json.createdProducts).toEqual([]);
    expect(res.json.failed[0].reason).toMatch(/JPY cannot be imported yet/);
    const rows = await sql`select id from products where site_id = ${siteId} and slug = ${`yen-bowl-${stamp}`}`;
    expect(rows).toHaveLength(0);
  });

  it("parses a CSV in the organization's currency and reports unknown stock", async () => {
    const form = new FormData();
    form.append("file", new Blob(["name,price,stock\nCandle,12.50,\n"], { type: "text/csv" }), "p.csv");
    const res = await merchant.postForm("/api/import", form);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const org = (await merchant.get("/api/me")).json.org;
    expect(res.json.imported[0]).toMatchObject({
      priceCents: 1250,
      currency: org.currency,
      stock: 0,
      stockKnown: false,
    });
    const codes = res.json.warnings.map((w: { code: string }) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["STOCK_UNKNOWN", "CURRENCY_ASSUMED"]));
  });
});
