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
  parsePriceToMinor,
  productsFromJsonLd,
  wooVariants,
  MAX_IMPORT_PRODUCTS,
  MAX_VARIATION_FETCHES,
} = await import("./importer");

describe("parsePriceToMinor", () => {
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
    expect(parsePriceToMinor(input)).toBe(cents);
  });

  /** Rounding a price is a decision about money; the importer refuses instead. */
  it.each([["19.995"], ["-5"], ["abc"], [""], [null], ["1e3"]])("refuses %j", (input) => {
    expect(parsePriceToMinor(input)).toBeNull();
  });

  /** 0.1 + 0.2 style drift is impossible: the arithmetic is on integers. */
  it("never drifts on values that are inexact in binary", () => {
    expect(parsePriceToMinor("0.29")).toBe(29);
    expect(parsePriceToMinor("1.15")).toBe(115);
    expect(parsePriceToMinor("4.35")).toBe(435);
  });

  /** The currency's own minor unit (D49): ¥1,500 is 1500, 5.125 KWD is 5125 fils. */
  it("reads into the currency's own exponent", () => {
    expect(parsePriceToMinor("1,500", 0)).toBe(1500);
    expect(parsePriceToMinor("1500.00", 0)).toBe(1500);
    expect(parsePriceToMinor("5.125", 3)).toBe(5125);
    expect(parsePriceToMinor("5.1", 3)).toBe(5100);
  });

  it("refuses precision the currency does not have", () => {
    expect(parsePriceToMinor("1500.5", 0)).toBeNull();
    expect(parsePriceToMinor("5.1255", 3)).toBeNull();
  });
});

describe("importableCurrency", () => {
  /** Display and checkout both read `priceCents` in the currency's own minor unit now (D49). */
  it("accepts any three-letter code, whatever its decimals", () => {
    for (const c of ["USD", "EUR", "GBP", "CAD", "JPY", "KRW", "KWD", "BHD"]) {
      expect(importableCurrency(c), c).toBe(true);
    }
  });

  /**
   * Every product schema requires a three-letter code, so a staged USDC row
   * failed the wizard's whole preview and would have failed the commit batch.
   */
  it("refuses USDC, which no product schema accepts", async () => {
    const { bundleProductSchema, importItemSchema } = await import("./validation");
    expect(importableCurrency("USDC")).toBe(false);
    expect(bundleProductSchema.safeParse({ name: "x", currency: "USDC" }).success).toBe(false);
    expect(importItemSchema.safeParse({ tempId: "a", name: "x", currency: "USDC" }).success).toBe(false);
    const r = importFromCsv("name,price,currency\nCoin,5,USDC\nMug,5,USD", { defaultCurrency: "USD" });
    expect(r.imported.map((i) => i.currency)).toEqual(["USD"]);
    expect(r.failed[0]).toMatchObject({ row: 2, name: "Coin" });
  });

  it("refuses anything that is not three upper-case letters", () => {
    for (const c of ["usd", "US", "US1", ""]) expect(importableCurrency(c), c).toBe(false);
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

  it("refuses a row in something that is not a currency and keeps the rest", () => {
    const r = importFromCsv("name,price,currency\nA,100,YENS\nB,1,USD", { defaultCurrency: "USD" });
    expect(r.imported.map((i) => i.name)).toEqual(["B"]);
    expect(r.failed[0]).toMatchObject({ row: 2, name: "A" });
    expect(r.failed[0].reason).toMatch(/not a currency code/);
  });

  /** ¥1,500 stages as 1500, not 150000: the price is read in the row's own currency. */
  it("reads a yen price in yen, and refuses fractions of a yen", () => {
    const r = importFromCsv('name,price,currency\nTea,"1,500",JPY\nOdd,1500.5,JPY', {
      defaultCurrency: "USD",
    });
    expect(r.imported.map((i) => [i.name, i.priceCents, i.currency])).toEqual([["Tea", 1500, "JPY"]]);
    expect(r.failed[0]).toMatchObject({ row: 3, name: "Odd" });
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

  it("reads a yen store in yen, including one configured with two decimals", () => {
    const r = fromWoo([
      woo({ prices: { price: "1000", currency_code: "JPY", currency_minor_unit: 0 } }),
      woo({ slug: "b", prices: { price: "150000", currency_code: "JPY", currency_minor_unit: 2 } }),
      woo({ slug: "c", prices: { price: "150050", currency_code: "JPY", currency_minor_unit: 2 } }),
    ]);
    expect(r.items.map((i) => [i.priceCents, i.currency])).toEqual([
      [1000, "JPY"],
      [1500, "JPY"],
    ]);
    // ¥1,500.50 has no exact yen amount; refused rather than rounded.
    expect(r.failed).toHaveLength(1);
  });

  it("flags products whose variations could not be read", () => {
    const r = fromWoo([woo({ slug: "v", type: "variable", variations: [{ id: 9 }] })]);
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

// ---------- WooCommerce variations and provenance (2026-10-23) ----------

/** A variable WooCommerce product, as the Store API lists it: ids and picks, no prices. */
const variable = (overrides: Record<string, unknown> = {}) => ({
  id: 40,
  name: "Hoodie",
  slug: "hoodie",
  permalink: "https://woo.test/product/hoodie/",
  type: "variable",
  prices: { price: "3000", currency_code: "USD", currency_minor_unit: 2 },
  is_in_stock: true,
  sku: "HOOD",
  images: [],
  categories: [],
  attributes: [
    {
      name: "Size",
      taxonomy: "pa_size",
      has_variations: true,
      terms: [
        { name: "Small", slug: "small" },
        { name: "Large", slug: "large" },
      ],
    },
  ],
  variations: [
    { id: 41, attributes: [{ name: "Size", value: "small" }] },
    { id: 42, attributes: [{ name: "Size", value: "large" }] },
  ],
  ...overrides,
});

const variation = (price: string, extra: Record<string, unknown> = {}) => ({
  prices: { price, regular_price: price, currency_code: "USD", currency_minor_unit: 2 },
  ...extra,
});

describe("WooCommerce variations", () => {
  it("builds options from attribute terms and each variant from its own record", () => {
    const byId = new Map<number, unknown>([
      [41, variation("3000", { sku: "HOOD-S" })],
      [
        42,
        variation("3500", {
          sku: "HOOD-L",
          prices: { price: "3500", regular_price: "4000", currency_code: "USD", currency_minor_unit: 2 },
        }),
      ],
    ]);
    const { items, withVariations } = fromWoo([variable()], 0, byId);
    expect(withVariations).toEqual([]);
    expect(items[0].options).toEqual([{ name: "Size", values: ["Small", "Large"] }]);
    expect(items[0].variants).toEqual([
      { title: "Small", optionValues: { Size: "Small" }, priceCents: 3000, compareAtCents: null, sku: "HOOD-S" },
      { title: "Large", optionValues: { Size: "Large" }, priceCents: 3500, compareAtCents: 4000, sku: "HOOD-L" },
    ]);
    // The parent SKU names nothing sellable once variants carry their own.
    expect(items[0].sku).toBeNull();
  });

  /** Some of a product's variants is a product a shopper cannot buy in the size you stock. */
  it("is all or nothing: a missing variation brings in the base product, flagged", () => {
    const r = fromWoo([variable()], 0, new Map([[41, variation("3000")]]));
    expect(r.items[0].variants).toBeUndefined();
    expect(r.withVariations).toEqual([r.items[0].tempId]);
  });

  it("refuses the wildcard value, which has no cell in an option grid", () => {
    const p = variable({ variations: [{ id: 41, attributes: [{ name: "Size", value: "" }] }] });
    expect(wooVariants(p, new Map([[41, variation("3000")]]), "USD")).toBeNull();
  });

  it("refuses a variation priced in another currency", () => {
    const eur = { prices: { price: "3000", currency_code: "EUR", currency_minor_unit: 2 } };
    expect(wooVariants(variable(), new Map<number, unknown>([[41, eur], [42, variation("3000")]]), "USD")).toBeNull();
  });
});

describe("provenance", () => {
  it("records each source's own id and page", () => {
    const shop = fromShopify({ products: [shopifyProduct({ id: 7001 })] }, "USD", 0, "https://shop.test");
    expect(shop.items[0]).toMatchObject({
      source: "shopify",
      sourceId: "7001",
      sourceUrl: "https://shop.test/products/tee",
    });

    const woo = fromWoo([variable({ type: "simple", variations: [] })]);
    expect(woo.items[0]).toMatchObject({
      source: "woocommerce",
      sourceId: "40",
      sourceUrl: "https://woo.test/product/hoodie/",
    });

    const csv = importFromCsv("name,price\nA,1", { defaultCurrency: "USD" });
    expect(csv.imported[0]).toMatchObject({ source: "csv", sourceId: null, sourceUrl: null });
  });

  it("gives a scraped product the page it was found on", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Lamp",
      offers: { price: "5", priceCurrency: "USD" },
    })}</script>`;
    expect(productsFromJsonLd(html, "https://x.test/p/lamp").items[0]).toMatchObject({
      source: "scrape",
      sourceId: null,
      sourceUrl: "https://x.test/p/lamp",
    });
  });
});

describe("fetching WooCommerce variations", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const variationCalls = () => fetchMock.mock.calls.filter((c) => /\/products\/\d+$/.test(String(c[0])));

  it("reads each variation once and brings the product in with its variants", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("products.json")) return new Response("", { status: 404 });
      if (url.includes("/products?per_page")) return json([variable()]);
      if (url.endsWith("/products/41")) return json(variation("3000"));
      if (url.endsWith("/products/42")) return json(variation("3200"));
      return new Response("", { status: 404 });
    });
    const r = await importFromUrl("https://woo.test/");
    expect(r.source).toBe("woocommerce");
    expect(r.imported[0].variants?.map((v) => v.priceCents)).toEqual([3000, 3200]);
    expect(r.warnings.map((w) => w.code)).not.toContain("VARIANTS_NOT_IMPORTED");
    expect(variationCalls()).toHaveLength(2);
  });

  /** The budget bounds an import's requests; past it products come in as their base, named. */
  it("stops reading variations at the budget and names the products left as their base", async () => {
    const many = Array.from({ length: MAX_VARIATION_FETCHES + 1 }, (_, i) => ({
      id: 1000 + i,
      attributes: [{ name: "Size", value: "small" }],
    }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("products.json")) return new Response("", { status: 404 });
      if (url.includes("/products?per_page")) return json([variable({ variations: many })]);
      return json(variation("3000"));
    });
    const r = await importFromUrl("https://woo.test/");
    expect(variationCalls()).toHaveLength(0);
    expect(r.warnings.find((w) => w.code === "VARIANTS_NOT_IMPORTED")?.tempIds).toEqual([r.imported[0].tempId]);
  });
});
