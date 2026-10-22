import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The importer (§5). Everything a migration gets wrong silently lives here —
 * a price misread, a currency guessed, a stock count invented, a catalogue
 * cut short — so each is pinned by the source shape that produced it.
 */

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) =>
    host === "metadata.evil.test"
      ? [{ address: "169.254.169.254", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
  ),
}));

const {
  fromShopify,
  fromWoo,
  htmlToText,
  importFromCsv,
  importFromUrl,
  importableCurrency,
  parsePriceToCents,
  productsFromJsonLd,
  MAX_IMPORT_PRODUCTS,
} = await import("./importer");

describe("parsePriceToCents", () => {
  it.each([
    ["19.99", 1999],
    ["19.9", 1990],
    ["20", 2000],
    [19.99, 1999],
    ["$1,299.00", 129900],
    ["1.299,50", 129950],
    ["19,99", 1999],
    ["1,299", 129900],
    ["0", 0],
    ["19.990", 1999],
  ])("reads %j as %i", (input, cents) => {
    expect(parsePriceToCents(input)).toBe(cents);
  });

  /** Rounding a price is a decision about money; the importer refuses instead. */
  it.each([["19.995"], ["-5"], ["abc"], [""], [null], ["1e3"]])("refuses %j", (input) => {
    expect(parsePriceToCents(input)).toBeNull();
  });

  /** 0.1 + 0.2 style drift is impossible: the arithmetic is on integers. */
  it("never drifts on values that are inexact in binary", () => {
    expect(parsePriceToCents("0.29")).toBe(29);
    expect(parsePriceToCents("1.15")).toBe(115);
    expect(parsePriceToCents("4.35")).toBe(435);
  });
});

describe("importableCurrency", () => {
  it("accepts two-decimal currencies, USDC included", () => {
    for (const c of ["USD", "EUR", "GBP", "CAD", "USDC"]) expect(importableCurrency(c), c).toBe(true);
  });

  /**
   * Storefront display and checkout read `priceCents` differently for these;
   * an imported yen product would show one price and charge 100× another.
   */
  it("refuses currencies whose minor unit is not cents", () => {
    for (const c of ["JPY", "KRW", "KWD", "BHD"]) expect(importableCurrency(c), c).toBe(false);
    expect(importableCurrency("usd")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("keeps paragraphs, decodes entities, drops scripts", () => {
    expect(
      htmlToText("<p>Soft &amp; warm.</p><p>Machine&nbsp;wash<br>cold</p><script>alert(1)</script>"),
    ).toBe("Soft & warm.\n\nMachine wash\ncold");
  });

  it("leaves plain text alone and empties to null", () => {
    expect(htmlToText("Just text")).toBe("Just text");
    expect(htmlToText("<p> </p>")).toBeNull();
    expect(htmlToText(null)).toBeNull();
  });
});

describe("CSV", () => {
  it("uses the organization's currency when there is no column, and says so", () => {
    const r = importFromCsv("name,price\nTee,19.99", { defaultCurrency: "EUR" });
    expect(r.imported[0]).toMatchObject({ currency: "EUR", priceCents: 1999 });
    expect(r.warnings.map((w) => w.code)).toContain("CURRENCY_ASSUMED");
  });

  /** A blank stock cell is unknown, not zero-by-accident and not ten. */
  it("stages a blank stock as unknown, and a stated one as known", () => {
    const r = importFromCsv("name,price,stock\nA,1,\nB,1,5", { defaultCurrency: "USD" });
    expect(r.imported.map((i) => [i.stock, i.stockKnown])).toEqual([
      [0, false],
      [5, true],
    ]);
    expect(r.warnings.find((w) => w.code === "STOCK_UNKNOWN")?.tempIds).toEqual(["imp_1"]);
  });

  it("refuses a row in an unsupported currency and keeps the rest", () => {
    const r = importFromCsv("name,price,currency\nA,100,JPY\nB,1,USD", { defaultCurrency: "USD" });
    expect(r.imported.map((i) => i.name)).toEqual(["B"]);
    expect(r.failed[0]).toMatchObject({ row: 2, name: "A" });
    expect(r.failed[0].reason).toMatch(/JPY cannot be imported yet/);
  });
});

const shopifyProduct = (overrides: Record<string, unknown> = {}) => ({
  title: "Tee",
  handle: "tee",
  body_html: "<p>Cotton &amp; love</p>",
  product_type: "Shirts",
  images: [{ src: "https://cdn.test/a.jpg" }],
  options: [{ name: "Title", values: ["Default Title"] }],
  variants: [{ title: "Default Title", option1: "Default Title", price: "25.00", sku: "TEE" }],
  ...overrides,
});

describe("Shopify", () => {
  it("stages a single-variant product without options, in the store's currency", () => {
    const { items } = fromShopify({ products: [shopifyProduct()] }, "EUR");
    expect(items[0]).toMatchObject({
      priceCents: 2500,
      currency: "EUR",
      sku: "TEE",
      description: "Cotton & love",
      stock: 0,
      stockKnown: false,
    });
    expect(items[0].options).toBeUndefined();
  });

  /** It used to keep the first variant and drop the rest. */
  it("keeps every variant with its own price, compare-at price and SKU", () => {
    const { items } = fromShopify(
      {
        products: [
          shopifyProduct({
            options: [
              { name: "Size", values: ["S", "M"] },
              { name: "Colour", values: ["Red", "Blue"] },
            ],
            variants: [
              { title: "S / Red", option1: "S", option2: "Red", price: "20.00", sku: "S-R" },
              { title: "M / Blue", option1: "M", option2: "Blue", price: "22.50", compare_at_price: "30.00", sku: "M-B" },
            ],
          }),
        ],
      },
      "USD",
    );
    const p = items[0];
    expect(p.options).toEqual([
      { name: "Size", values: ["S", "M"] },
      { name: "Colour", values: ["Red", "Blue"] },
    ]);
    expect(p.variants).toEqual([
      { title: "S / Red", optionValues: { Size: "S", Colour: "Red" }, priceCents: 2000, compareAtCents: null, sku: "S-R" },
      { title: "M / Blue", optionValues: { Size: "M", Colour: "Blue" }, priceCents: 2250, compareAtCents: 3000, sku: "M-B" },
    ]);
    expect(p.priceCents).toBe(2000);
    expect(p.sku).toBeNull();
  });

  it("trusts a stock count only when every variant publishes one", () => {
    const known = fromShopify(
      { products: [shopifyProduct({ variants: [{ price: "1", inventory_quantity: 4 }] })] },
      "USD",
    );
    expect(known.items[0]).toMatchObject({ stock: 4, stockKnown: true });
  });
});

describe("WooCommerce", () => {
  const woo = (overrides: Record<string, unknown> = {}) => ({
    name: "Mug &#8211; Large",
    slug: "mug",
    prices: { price: "1250", currency_code: "GBP", currency_minor_unit: 2 },
    is_in_stock: true,
    description: "<p>Holds tea.</p>",
    images: [],
    categories: [{ name: "Kitchen &amp; Home" }],
    ...overrides,
  });

  it("reads currency and minor units from the API, and decodes names", () => {
    const { items } = fromWoo([woo()]);
    expect(items[0]).toMatchObject({
      name: "Mug – Large",
      priceCents: 1250,
      currency: "GBP",
      categoryName: "Kitchen & Home",
      stockKnown: false,
    });
  });

  it("converts a store configured with fewer decimals exactly", () => {
    const { items } = fromWoo([woo({ prices: { price: "13", currency_code: "USD", currency_minor_unit: 0 } })]);
    expect(items[0].priceCents).toBe(1300);
  });

  it("knows 'out of stock' and 'only 3 left', and nothing else", () => {
    const { items } = fromWoo([woo({ is_in_stock: false }), woo({ slug: "b", low_stock_remaining: 3 })]);
    expect(items.map((i) => [i.stock, i.stockKnown])).toEqual([
      [0, true],
      [3, true],
    ]);
  });

  it("refuses an unsupported currency and flags products with variations", () => {
    const r = fromWoo([
      woo({ prices: { price: "1000", currency_code: "JPY", currency_minor_unit: 0 } }),
      woo({ slug: "v", type: "variable", variations: [{ id: 9 }] }),
    ]);
    expect(r.failed[0].reason).toMatch(/JPY/);
    expect(r.withVariations).toEqual([r.items[0].tempId]);
  });
});

describe("JSON-LD", () => {
  const page = (offer: Record<string, unknown>) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Lamp",
      offers: offer,
    })}</script>`;

  /** It used to assume USD. A price with no currency is not a price. */
  it("refuses a product whose page states no currency", () => {
    const r = productsFromJsonLd(page({ price: "40.00" }));
    expect(r.items).toEqual([]);
    expect(r.failed[0].reason).toMatch(/currency/);
  });

  it("reads OutOfStock as a known zero and InStock as unknown", () => {
    const out = productsFromJsonLd(page({ price: 40, priceCurrency: "CAD", availability: "https://schema.org/OutOfStock" }));
    const inStock = productsFromJsonLd(page({ price: 40, priceCurrency: "CAD", availability: "https://schema.org/InStock" }));
    expect(out.items[0]).toMatchObject({ stock: 0, stockKnown: true, priceCents: 4000 });
    expect(inStock.items[0]).toMatchObject({ stock: 0, stockKnown: false });
  });
});

describe("fetching a store", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  /** It used to read one page — 250 products — and stop without saying so. */
  it("pages through a large Shopify catalogue and reads the store currency", async () => {
    const make = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) =>
        shopifyProduct({ title: `P${from + i}`, handle: `p${from + i}` }),
      );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/products.json?limit=250")) return json({ products: make(250, 0) });
      if (url.includes("page=2")) return json({ products: make(10, 250) });
      if (url.endsWith("/meta.json")) return json({ currency: "EUR" });
      return new Response("", { status: 404 });
    });
    const r = await importFromUrl("https://shop.test/");
    expect(r.source).toBe("shopify");
    expect(r.imported).toHaveLength(260);
    expect(r.imported.every((p) => p.currency === "EUR")).toBe(true);
    expect(r.warnings.map((w) => w.code)).not.toContain("TRUNCATED");
  });

  it("stops at the cap and says the catalogue was cut short", async () => {
    let page = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("products.json")) {
        page += 1;
        return json({
          products: Array.from({ length: 250 }, (_, i) =>
            shopifyProduct({ title: `P${page}-${i}`, handle: `p${page}-${i}` }),
          ),
        });
      }
      if (url.endsWith("/meta.json")) return json({ currency: "USD" });
      return new Response("", { status: 404 });
    });
    const r = await importFromUrl("https://big.test/");
    expect(r.imported).toHaveLength(MAX_IMPORT_PRODUCTS);
    expect(r.warnings.map((w) => w.code)).toContain("TRUNCATED");
  });

  /** It used to label every Shopify price USD. Now an unknown currency refuses. */
  it("refuses a Shopify store whose currency cannot be read", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("products.json") ? json({ products: [shopifyProduct()] }) : new Response("", { status: 404 }),
    );
    const r = await importFromUrl("https://shop.test/");
    expect(r.imported).toEqual([]);
    expect(r.failed[0].reason).toMatch(/currency could not be read/);
  });

  /**
   * The URL was checked; where it redirected was not. A public host bouncing
   * the importer to cloud metadata must never be fetched.
   */
  it("does not follow a redirect into private address space", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://shop.test/products.json")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://metadata.evil.test/latest/meta-data/" },
        });
      }
      return new Response("", { status: 404 });
    });
    await importFromUrl("https://shop.test/");
    const fetched = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes("metadata.evil.test"))).toBe(false);
    for (const call of fetchMock.mock.calls) expect(call[1]?.redirect).toBe("manual");
  });
});
