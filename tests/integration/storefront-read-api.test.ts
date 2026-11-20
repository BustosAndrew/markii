import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * The storefront read API (D53) — what an exported Next.js storefront reads
 * from. Its claim is that it adds a shape and no reach: published design only,
 * enabled products only, published collections only, never head code, and
 * nothing at all from a halted store. Each of those is asserted here against
 * the real routes, because each is a filter a refactor could drop silently.
 */
describe("storefront read API", () => {
  const merchant = new Client();
  const anyone = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let products: any[];
  const stamp = Date.now();

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const read = async (p: string) => {
    const res = await anyone.getRaw(`/_sites/${slug}${p}`);
    return { ...res, json: res.text ? JSON.parse(res.text) : null };
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "readapi");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "readapi", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    products = store.products;
  }, 120_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("answers the store with no design before one is published — readable from any origin, no credentials", async () => {
    const res = await read("/api/store");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.json.store).toMatchObject({ slug, purchasesEnabled: true, rails: { x402: true, stripe: false } });
    expect(res.json.design).toBeNull();
  });

  it("pages the enabled catalogue in minor units and leaves out a disabled product", async () => {
    await sql`update products set enabled = false where id = ${products[1].id}`;
    try {
      const first = await read("/api/products?limit=1");
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ total: 2, limit: 1, offset: 0, next: 1 });
      expect(first.json.products[0]).toMatchObject({ slug: products[0].slug, priceMinor: products[0].price_cents, currency: "USD" });
      const second = await read("/api/products?limit=1&offset=1");
      expect(second.json.next).toBeNull();
      expect(second.json.products[0].slug).toBe(products[2].slug);
      expect((await read(`/api/products/${products[1].slug}`)).status).toBe(404);
    } finally {
      await sql`update products set enabled = true where id = ${products[1].id}`;
    }
  });

  it("answers one product with its options and variants, and 404s an unknown slug", async () => {
    const res = await read(`/api/products/${products[0].slug}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: products[0].id, slug: products[0].slug, membersOnly: false });
    expect(Array.isArray(res.json.options)).toBe(true);
    expect(Array.isArray(res.json.variants)).toBe(true);
    expect((await read("/api/products/no-such-product")).status).toBe(404);
  });

  it("serves a published collection's members and 404s an unpublished one", async () => {
    const draft = await act("catalog.createCollection", { siteId, title: "Draft", handle: `draft-${stamp}`, published: false });
    expect(draft.status).toBe(200);
    expect((await read(`/api/collections/draft-${stamp}`)).status).toBe(404);

    const live = await act("catalog.createCollection", { siteId, title: "Picks", handle: `picks-${stamp}`, published: true });
    expect(live.status).toBe(200);
    await act("catalog.setCollectionProducts", { collectionId: live.json.result.id, productIds: [products[2].id, products[0].id] });
    const res = await read(`/api/collections/picks-${stamp}`);
    expect(res.status).toBe(200);
    expect(res.json.collection).toMatchObject({ handle: `picks-${stamp}`, title: "Picks" });
    expect(res.json.products.map((p: any) => p.id)).toEqual([products[2].id, products[0].id]);
    expect((await read("/api/store")).json.collections.map((c: any) => c.handle)).toContain(`picks-${stamp}`);
  });

  it("serves the published design as a theme package — never the draft, never head code", async () => {
    expect((await act("builder.startDesign", { siteId })).status).toBe(200);
    expect((await act("builder.setTheme", { siteId, themeId: "noir" })).status).toBe(200);
    expect((await act("builder.publish", { siteId })).status).toBe(200);
    // Draft-only work after the publish, and head code on the published row.
    expect((await act("builder.createPage", { siteId, handle: `draft-only-${stamp}`, title: "Unpublished" })).status).toBe(200);
    await sql`update site_designs set published_head_html = '<meta name="secret-head-code">' where site_id = ${siteId}`;

    const res = await read("/api/store");
    expect(res.status).toBe(200);
    expect(res.json.design).toMatchObject({ format: "markii.theme", version: 1, theme: { themeId: "noir" }, savedBlocks: [] });
    expect(res.json.design.documents.map((d: any) => `${d.kind}:${d.handle}`)).toContain("page:home");
    expect(res.text).not.toContain(`draft-only-${stamp}`);
    expect(res.text).not.toContain("secret-head-code");
  });

  it("answers nothing from a paused store", async () => {
    await sql`update sites set status = 'paused' where id = ${siteId}`;
    try {
      for (const p of ["/api/store", "/api/products", `/api/products/${products[0].slug}`, `/api/collections/picks-${stamp}`]) {
        expect((await read(p)).status, p).toBe(404);
      }
    } finally {
      await sql`update sites set status = 'live' where id = ${siteId}`;
    }
  });
});
