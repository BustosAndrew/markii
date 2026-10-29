import { describe, expect, it } from "vitest";
import { formatPrice, generateAgentMd, generateLlmsTxt, productJsonLd, type Bundle } from "./generators";

/**
 * What a shopper reads and what an agent parses must be what checkout charges.
 * `priceCents` is the currency's own minor unit (D49); until 2026-10-29 these
 * divided by 100 for every currency, so a ¥1,500 product published as ¥15.
 */
const bundle = (currency: string, priceCents: number): Bundle => ({
  site: { name: "Tea House", slug: "tea" },
  categories: [],
  products: [{ name: "Sencha", slug: "sencha", priceCents, currency, stock: 3, images: [] }],
});

describe("formatPrice", () => {
  it("keeps the dollar form for USD and USDC", () => {
    expect(formatPrice(1999, "USD")).toBe("$19.99");
    expect(formatPrice(1999, "USDC")).toBe("$19.99");
  });

  it("uses the currency's own decimals", () => {
    expect(formatPrice(1500, "JPY")).toBe("1500 JPY");
    expect(formatPrice(1250, "EUR")).toBe("12.50 EUR");
    expect(formatPrice(5125, "KWD")).toBe("5.125 KWD");
  });
});

describe("productJsonLd", () => {
  it("publishes offers.price in the currency's own decimals", () => {
    const yen = bundle("JPY", 1500);
    expect(productJsonLd(yen, yen.products[0], "https://tea.test").offers).toMatchObject({
      price: "1500",
      priceCurrency: "JPY",
    });
    const usd = bundle("USD", 1999);
    expect(productJsonLd(usd, usd.products[0], "https://tea.test").offers).toMatchObject({
      price: "19.99",
      priceCurrency: "USD",
    });
  });
});

describe("agent documents", () => {
  it("list a yen price as charged", () => {
    expect(generateLlmsTxt(bundle("JPY", 1500), "https://tea.test")).toContain("1500 JPY");
  });

  it("tell an agent that x402 takes USD prices only", () => {
    const md = generateAgentMd(bundle("USD", 1999), "https://tea.test", { rails: { x402: true } });
    expect(md).toContain("USD prices only");
  });
});
