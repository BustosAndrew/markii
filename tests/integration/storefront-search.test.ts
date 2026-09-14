import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, sql } from "./helpers";

/**
 * Storefront search (G6) — `GET /_sites/:site/api/search` and the `/search`
 * page, against a real `tsvector`.
 *
 * What is worth proving here is not that Postgres can search — it is the
 * wiring around it: that a store's search cannot answer from a neighbour's
 * catalogue, that a disabled product is as absent from search as it is from
 * every page, that ranking prefers the product *named* for the query over one
 * that mentions it, and that the fallback catches what the stemmer cannot.
 * Every one of those is a filter or an ORDER BY, and none is reachable from a
 * unit test.
 */
describe("storefront search", () => {
  const client = new Client();
  const cleanup = new Cleanup();
  let slug: string;
  let siteId: number;
  let neighbourSlug: string;

  const api = (q: string, extra = "") => `/_sites/${slug}/api/search?q=${encodeURIComponent(q)}${extra}`;

  async function addProduct(
    site: number,
    p: { name: string; slug: string; sku?: string; description?: string; enabled?: boolean },
  ) {
    const [row] = await sql`insert into products
      (site_id, name, slug, sku, description, price_cents, currency, stock, enabled)
      values (${site}, ${p.name}, ${p.slug}, ${p.sku ?? null}, ${p.description ?? null},
              2500, 'USD', 4, ${p.enabled ?? true})
      returning id`;
    return row.id as number;
  }

  beforeAll(async () => {
    const store = await createTestStore(cleanup, "search");
    slug = store.slug;
    siteId = store.site.id;

    // A product *named* for the query, one that mentions it, and one that
    // mentions it inside HTML the shopper never sees.
    await addProduct(siteId, {
      name: "Leather Wallet",
      slug: "leather-wallet",
      sku: "LW-100",
      description: "<p>Full-grain leather, hand stitched.</p>",
    });
    await addProduct(siteId, {
      name: "Card Holder",
      slug: "card-holder",
      sku: "CH-200",
      description: "<p>Slim. Fits beside a <strong>wallet</strong> or on its own.</p>",
    });
    await addProduct(siteId, {
      name: "Hidden Wallet",
      slug: "hidden-wallet",
      enabled: false,
    });
    await addProduct(siteId, {
      name: "Zürich Tote",
      slug: "zurich-tote",
      sku: "ZT-300",
    });

    // The same product name in another store — the one result that must never appear.
    const neighbour = await createTestStore(cleanup, "search-neighbour");
    neighbourSlug = neighbour.slug;
    await addProduct(neighbour.site.id, { name: "Leather Wallet", slug: "leather-wallet" });
  });

  afterAll(async () => {
    await cleanup.run();
  });

  it("ranks the product named for the query above one that mentions it", async () => {
    const r = await client.get(api("wallet"));
    expect(r.status).toBe(200);
    const slugs = r.json.results.map((p: any) => p.slug);
    expect(slugs).toEqual(["leather-wallet", "card-holder"]);
    expect(r.json.count).toBe(2);
    expect(r.json.query).toBe("wallet");
  });

  it("stems, so the plural finds the singular", async () => {
    const r = await client.get(api("wallets"));
    expect(r.json.results.map((p: any) => p.slug)).toContain("leather-wallet");
  });

  it("finds a product by SKU", async () => {
    const r = await client.get(api("CH-200"));
    expect(r.json.results.map((p: any) => p.slug)).toEqual(["card-holder"]);
  });

  it("falls back to a substring match for a partial word the stemmer cannot see", async () => {
    const r = await client.get(api("zür"));
    expect(r.json.results.map((p: any) => p.slug)).toEqual(["zurich-tote"]);
  });

  it("does not match HTML tag names in a description", async () => {
    // "strong" appears only as a tag around "wallet" in the card holder's copy.
    const r = await client.get(api("strong"));
    expect(r.json.results).toEqual([]);
  });

  it("excludes disabled products, exactly as every storefront page does", async () => {
    const r = await client.get(api("hidden"));
    expect(r.json.results).toEqual([]);
  });

  it("never answers from another store's catalogue", async () => {
    const mine = await client.get(api("leather"));
    expect(mine.json.results).toHaveLength(1);
    expect(mine.json.results[0].url).toContain(`/p/leather-wallet`);

    const theirs = await client.get(
      `/_sites/${neighbourSlug}/api/search?q=${encodeURIComponent("card holder")}`,
    );
    expect(theirs.status).toBe(200);
    expect(theirs.json.results).toEqual([]);
  });

  it("describes each result in the shape agent.md documents", async () => {
    const r = await client.get(api("LW-100"));
    const [hit] = r.json.results;
    expect(hit).toMatchObject({
      name: "Leather Wallet",
      slug: "leather-wallet",
      sku: "LW-100",
      description: "Full-grain leather, hand stitched.",
      priceMinor: 2500,
      currency: "USD",
      stock: 4,
      inStock: true,
      category: null,
      membersOnly: false,
    });
    expect(hit.url).toMatch(/\/p\/leather-wallet$/);
    expect(hit).not.toHaveProperty("priceCents");
  });

  it("refuses an empty query rather than answering with an empty list", async () => {
    const r = await client.get(`/_sites/${slug}/api/search?q=%20%20`);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION_ERROR");
    const missing = await client.get(`/_sites/${slug}/api/search`);
    expect(missing.status).toBe(400);
  });

  it("survives what people actually type", async () => {
    for (const q of ['"leather wallet"', "wallet -leather", "100%", "a_b", "'; drop table products; --", "(("]) {
      const r = await client.get(api(q));
      expect(r.status, q).toBe(200);
    }
    const excluded = await client.get(api("wallet -leather"));
    expect(excluded.json.results.map((p: any) => p.slug)).toEqual(["card-holder"]);
  });

  it("clamps the limit", async () => {
    const r = await client.get(api("wallet", "&limit=1"));
    expect(r.json.limit).toBe(1);
    expect(r.json.results).toHaveLength(1);
    const big = await client.get(api("wallet", "&limit=9999"));
    expect(big.json.limit).toBe(50);
  });

  it("renders the same results as HTML on /search, with the box pre-filled", async () => {
    const page = await client.getRaw(`/_sites/${slug}/search?q=wallet`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Leather Wallet");
    expect(page.text).toContain("Card Holder");
    expect(page.text).not.toContain("Hidden Wallet");
    expect(page.text).toMatch(/<input[^>]*name="q"[^>]*value="wallet"/);
    expect(page.text).toMatch(/<meta name="robots" content="noindex/);
  });

  it("advertises the endpoint in llms.txt and agent.md", async () => {
    const llms = await client.getRaw(`/_sites/${slug}/llms.txt`);
    expect(llms.text).toContain(`/api/search?q={query}`);
    const agent = await client.getRaw(`/_sites/${slug}/agent.md`);
    expect(agent.text).toContain("## Search");
    expect(agent.text).toContain(`/api/search?q={query}&limit={1..50}`);
  });

  it("is 404 on a paused store, like every other storefront route", async () => {
    await sql`update sites set status = 'paused' where id = ${siteId}`;
    try {
      const r = await client.get(api("wallet"));
      expect(r.status).toBe(404);
      const page = await client.getRaw(`/_sites/${slug}/search?q=wallet`);
      expect(page.status).toBe(404);
    } finally {
      await sql`update sites set status = 'live' where id = ${siteId}`;
    }
  });
});
