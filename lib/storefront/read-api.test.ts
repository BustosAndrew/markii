import { describe, expect, it } from "vitest";
import type { Category, Collection, Product } from "@/lib/db";
import type { SiteData } from "@/lib/storefront";
import type { ThemePackage } from "@/lib/builder/theme-package";
import { pageParams, PRODUCT_PAGE_MAX, productJson, READ_API_HEADERS, storeJson } from "./read-api";

const product = (over: Partial<Product>): Product =>
  ({
    id: 1, slug: "tea", name: "Green tea", enabled: true, priceCents: 1500, currency: "JPY", stock: 3,
    categoryId: 7, suggestedProductIds: [], images: ["https://cdn.test/t.jpg"], description: "<p>Loose <b>leaf</b></p>",
    sku: "T-1", requiresTierId: null, costMinor: 400, ...over,
  }) as unknown as Product;

const prods = [product({ suggestedProductIds: [2, 3] }), product({ id: 2, slug: "mug" }), product({ id: 3, slug: "old", enabled: false })];

const data = {
  site: { name: "Leaf", slug: "leaf", purchasesEnabled: true, paymentProviders: { stripe: true, x402: false } },
  baseUrl: "https://leaf.test",
  prods,
  cats: [{ id: 7, parentId: null, name: "Teas", slug: "teas", description: null, enabled: true }, { id: 8, name: "Hidden", slug: "h", enabled: false }] as Category[],
  colls: [{ id: 4, handle: "new", title: "New", description: null, imageUrl: null }] as Collection[],
} as unknown as SiteData;

describe("the storefront read API's shapes (D53)", () => {
  it("a product is what its page already shows — minor units, no cost, enabled suggestions only", () => {
    const json = productJson(data, prods[0]);
    expect(json).toMatchObject({ priceMinor: 1500, currency: "JPY", url: "https://leaf.test/p/tea", summary: "Loose leaf", inStock: true, membersOnly: false });
    expect(json.suggestedProductIds).toEqual([2]);
    expect(Object.keys(json)).not.toContain("costMinor");
    expect(Object.keys(json)).not.toContain("priceCents");
  });

  it("says a gated product is members-only", () => {
    expect(productJson(data, product({ requiresTierId: 9 })).membersOnly).toBe(true);
  });

  it("the store lists enabled categories and the design without saved blocks", () => {
    const design = { format: "markii.theme", version: 1, theme: { themeId: "atlas", tokens: {}, customCss: "" }, documents: [], savedBlocks: [{ name: "x", node: { type: "text" } }] } as unknown as ThemePackage;
    const json = storeJson(data, design);
    expect(json.store).toEqual({ name: "Leaf", slug: "leaf", url: "https://leaf.test", purchasesEnabled: true, rails: { stripe: true, x402: false } });
    expect(json.categories.map((c) => c.slug)).toEqual(["teas"]);
    expect(json.collections[0].url).toBe("https://leaf.test/collections/new");
    expect(json.design?.savedBlocks).toEqual([]);
    // Head code is not part of a theme package at all, so it cannot leak here.
    expect(JSON.stringify(json)).not.toContain("headHtml");
    expect(storeJson(data, null).design).toBeNull();
  });

  it("clamps paging rather than refusing it", () => {
    expect(pageParams(new URLSearchParams("limit=9999&offset=-4"))).toEqual({ limit: PRODUCT_PAGE_MAX, offset: 0 });
    expect(pageParams(new URLSearchParams("limit=abc"))).toEqual({ limit: 50, offset: 0 });
  });

  it("any origin may read and none may send credentials", () => {
    expect(READ_API_HEADERS["access-control-allow-origin"]).toBe("*");
    expect(Object.keys(READ_API_HEADERS)).not.toContain("access-control-allow-credentials");
  });
});
