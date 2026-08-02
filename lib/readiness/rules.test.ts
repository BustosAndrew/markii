import { describe, expect, it } from "vitest";
import { issueId, productFindings, storeFindings, type ProductFacts, type StoreFacts } from "./rules";

/**
 * Readiness rules (§9) — pure, no database.
 *
 * Two properties matter more than any individual rule. **Determinism**: the same
 * catalog must produce the same issues with the same ids, or a dismissal cannot
 * survive to tomorrow. And **no fabricated criticism**: a rule may only check a
 * field the platform actually offers, so nothing here scores a merchant on the
 * unbuilt §11 agent-data extension.
 */

const product = (over: Partial<ProductFacts> = {}): ProductFacts => ({
  id: 1,
  siteId: 1,
  categoryId: null,
  name: "Blue Tee",
  description: "A comfortable cotton t-shirt in navy blue, pre-shrunk and machine washable. ".repeat(3),
  priceCents: 2500,
  sku: "TEE-BLUE",
  images: ["https://example.test/tee.jpg"],
  enabled: true,
  variants: [{ id: 10, sku: "TEE-BLUE-M", barcode: "5012345678900", weightGrams: 180, requiresShipping: true }],
  stock: 0,
  variantStock: 12,
  ...over,
});

const store = (over: Partial<StoreFacts> = {}): StoreFacts => ({
  id: 1,
  name: "Test Store",
  status: "live",
  indexed: true,
  agentDiscovery: true,
  purchasesEnabled: true,
  paymentProviders: { x402: true },
  walletAddress: "0xabc",
  orgWalletAddress: null,
  customDomain: "shop.example.test",
  enabledProductCount: 4,
  sellsShippable: true,
  shippingZoneCount: 1,
  emptyShippingZoneCount: 0,
  taxProvider: "none",
  manualTaxRateCount: 0,
  locationCount: 1,
  hasVariantBackedProducts: true,
  stripeConfigured: false,
  ...over,
});

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe("issueId", () => {
  it("is stable for the same rule and subject", () => {
    const scope = { siteId: 1, productId: 9, categoryId: null };
    expect(issueId("NO_IMAGES", scope)).toBe(issueId("NO_IMAGES", scope));
  });

  it("differs across products, so two products' issues are separately dismissible", () => {
    expect(issueId("NO_IMAGES", { siteId: 1, productId: 9, categoryId: null })).not.toBe(
      issueId("NO_IMAGES", { siteId: 1, productId: 10, categoryId: null }),
    );
  });

  it("differs across rules on the same product", () => {
    const scope = { siteId: 1, productId: 9, categoryId: null };
    expect(issueId("NO_IMAGES", scope)).not.toBe(issueId("MISSING_SKU", scope));
  });
});

describe("productFindings", () => {
  it("finds nothing wrong with a complete product", () => {
    expect(productFindings(product())).toEqual([]);
  });

  it("ignores disabled products entirely", () => {
    // A tidy catalog with drafts must not score worse than a neglected one.
    const bad = product({ enabled: false, description: null, images: [], priceCents: 0 });
    expect(productFindings(bad)).toEqual([]);
  });

  it("flags a missing description as critical", () => {
    const found = productFindings(product({ description: null }));
    expect(codes(found)).toContain("MISSING_DESCRIPTION");
    expect(found.find((f) => f.code === "MISSING_DESCRIPTION")?.severity).toBe("critical");
  });

  it("treats whitespace as no description", () => {
    expect(codes(productFindings(product({ description: "   \n  " })))).toContain(
      "MISSING_DESCRIPTION",
    );
  });

  it("flags a short description as a warning, not a critical", () => {
    const found = productFindings(product({ description: "Nice shirt." }));
    expect(codes(found)).toContain("SHORT_DESCRIPTION");
    expect(codes(found)).not.toContain("MISSING_DESCRIPTION");
    expect(found.find((f) => f.code === "SHORT_DESCRIPTION")?.severity).toBe("warning");
  });

  it("flags no images and no price as critical", () => {
    const found = codes(productFindings(product({ images: [], priceCents: 0 })));
    expect(found).toContain("NO_IMAGES");
    expect(found).toContain("PRICE_NOT_SET");
  });

  it("accepts a product SKU when there are no variants", () => {
    const found = codes(productFindings(product({ variants: [], sku: "ABC", variantStock: null, stock: 5 })));
    expect(found).not.toContain("MISSING_SKU");
  });

  it("requires a SKU on every variant, not just one", () => {
    const found = codes(
      productFindings(
        product({
          variants: [
            { id: 1, sku: "A", barcode: null, weightGrams: 100, requiresShipping: true },
            { id: 2, sku: null, barcode: null, weightGrams: 100, requiresShipping: true },
          ],
        }),
      ),
    );
    expect(found).toContain("MISSING_SKU");
  });

  it("does not ask a digital product for a shipping weight", () => {
    // Nothing about a download has a weight, and asking for one is noise that
    // makes the whole list less credible.
    const digital = product({
      variants: [{ id: 10, sku: "EBOOK", barcode: null, weightGrams: null, requiresShipping: false }],
    });
    expect(codes(productFindings(digital))).not.toContain("MISSING_WEIGHT");
  });

  it("asks a shippable product for a weight", () => {
    const noWeight = product({
      variants: [{ id: 10, sku: "TEE", barcode: "1", weightGrams: null, requiresShipping: true }],
    });
    expect(codes(productFindings(noWeight))).toContain("MISSING_WEIGHT");
  });

  it("flags an enabled product with no stock", () => {
    expect(codes(productFindings(product({ variantStock: 0 })))).toContain("OUT_OF_STOCK");
  });

  it("reads the legacy counter only when there are no variants", () => {
    const legacy = product({ variants: [], variantStock: null, stock: 7, sku: "X" });
    expect(codes(productFindings(legacy))).not.toContain("OUT_OF_STOCK");
    // But it does say the stock is untracked, which is the real problem.
    expect(codes(productFindings(legacy))).toContain("UNTRACKED_INVENTORY");
  });

  it("never scores the unbuilt §11 agent-data fields", () => {
    // If these ever appear, someone has added a rule for a field merchants have
    // no way to fill.
    const all = codes(productFindings(product({ description: null, images: [], priceCents: 0 })));
    for (const forbidden of ["USE_CASES", "FAQ", "MACHINE_SUMMARY", "COMPATIBILITY", "DIMENSIONS"]) {
      expect(all.some((c) => c.includes(forbidden))).toBe(false);
    }
  });

  it("is deterministic", () => {
    const p = product({ description: null, images: [] });
    expect(productFindings(p)).toEqual(productFindings(p));
  });
});

describe("storeFindings", () => {
  it("finds nothing wrong with a fully configured live store", () => {
    expect(storeFindings(store())).toEqual([]);
  });

  it("flags a store with no payment rail as critical", () => {
    const found = storeFindings(store({ paymentProviders: {} }));
    expect(codes(found)).toContain("NO_PAYMENT_RAIL");
    expect(found.find((f) => f.code === "NO_PAYMENT_RAIL")?.severity).toBe("critical");
  });

  it("accepts an org-level wallet when the store has none", () => {
    const found = codes(storeFindings(store({ walletAddress: null, orgWalletAddress: "0xdef" })));
    expect(found).not.toContain("NO_WALLET");
  });

  it("flags x402 with no wallet anywhere", () => {
    expect(codes(storeFindings(store({ walletAddress: null, orgWalletAddress: null })))).toContain(
      "NO_WALLET",
    );
  });

  it("flags shippable goods with no shipping zone", () => {
    expect(codes(storeFindings(store({ shippingZoneCount: 0 })))).toContain("NO_SHIPPING_ZONE");
  });

  it("does not ask a digital-only store for shipping zones", () => {
    // The D5 beachhead sells files. Demanding shipping configuration it will
    // never use would make the score actively misleading for its best segment.
    const digitalStore = store({ sellsShippable: false, shippingZoneCount: 0 });
    expect(codes(storeFindings(digitalStore))).not.toContain("NO_SHIPPING_ZONE");
  });

  it("flags a zone that quotes nothing", () => {
    expect(codes(storeFindings(store({ emptyShippingZoneCount: 2 })))).toContain(
      "SHIPPING_ZONE_WITHOUT_RATES",
    );
  });

  it("flags manual tax with no rates, but leaves provider none alone", () => {
    expect(codes(storeFindings(store({ taxProvider: "manual", manualTaxRateCount: 0 })))).toContain(
      "MANUAL_TAX_WITHOUT_RATES",
    );
    // `none` is an explicit, legitimate choice (D33) — not a misconfiguration.
    expect(codes(storeFindings(store({ taxProvider: "none" })))).not.toContain(
      "MANUAL_TAX_WITHOUT_RATES",
    );
  });

  it("flags variant-backed products with no stock location", () => {
    expect(codes(storeFindings(store({ locationCount: 0 })))).toContain("NO_STOCK_LOCATION");
  });

  it("flags agent discovery being off as critical", () => {
    const found = storeFindings(store({ agentDiscovery: false }));
    expect(codes(found)).toContain("AGENT_DISCOVERY_OFF");
    expect(found.find((f) => f.code === "AGENT_DISCOVERY_OFF")?.severity).toBe("critical");
  });

  it("flags a live store with purchases switched off", () => {
    expect(codes(storeFindings(store({ purchasesEnabled: false })))).toContain(
      "PURCHASES_DISABLED",
    );
  });

  it("does not flag purchases off on a draft store", () => {
    const draft = store({ status: "draft", purchasesEnabled: false });
    expect(codes(storeFindings(draft))).not.toContain("PURCHASES_DISABLED");
    expect(codes(storeFindings(draft))).toContain("STORE_NOT_LIVE");
  });

  it("warns when card payments are on but unavailable", () => {
    const found = storeFindings(
      store({ paymentProviders: { x402: true, stripe: true }, stripeConfigured: false }),
    );
    expect(codes(found)).toContain("CARD_RAIL_UNAVAILABLE");
  });

  it("does not warn about cards once Stripe is configured", () => {
    const found = storeFindings(
      store({ paymentProviders: { x402: true, stripe: true }, stripeConfigured: true }),
    );
    expect(codes(found)).not.toContain("CARD_RAIL_UNAVAILABLE");
  });

  it("every finding carries a recommendation and an impact", () => {
    // An issue a merchant cannot act on is noise. This is the property that
    // keeps the list useful rather than long.
    const found = storeFindings(
      store({
        paymentProviders: {},
        agentDiscovery: false,
        shippingZoneCount: 0,
        locationCount: 0,
        enabledProductCount: 0,
        status: "draft",
        indexed: false,
        customDomain: null,
      }),
    );
    expect(found.length).toBeGreaterThan(4);
    for (const f of found) {
      expect(f.recommendation.length).toBeGreaterThan(10);
      expect(f.expectedImpact.length).toBeGreaterThan(10);
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });
});
