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
  domainStatus: "verified",
  enabledProductCount: 4,
  sellsShippable: true,
  shippingZoneCount: 1,
  emptyShippingZoneCount: 0,
  taxProvider: "none",
  manualTaxRateCount: 0,
  locationCount: 1,
  hasVariantBackedProducts: true,
  stripeConfigured: false,
  stripeConnected: false,
  // Default to a store that *can* email, so NO_CUSTOMER_EMAIL does not appear
  // in every unrelated assertion below.
  emailProviderConfigured: true,
  customerEmailReady: true,
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

  it("flags Stripe Tax selected with no Stripe account connected", () => {
    expect(
      codes(storeFindings(store({ taxProvider: "stripe", stripeConfigured: true, stripeConnected: false }))),
    ).toContain("STRIPE_TAX_WITHOUT_CONNECTION");
  });

  it("says nothing once the merchant has connected Stripe", () => {
    // Whether Stripe Tax is *activated* on that account needs a live API call,
    // so it is reported on the tax settings screen rather than guessed at here.
    expect(
      codes(storeFindings(store({ taxProvider: "stripe", stripeConfigured: true, stripeConnected: true }))),
    ).not.toContain("STRIPE_TAX_WITHOUT_CONNECTION");
  });

  it("stays silent when it is Markii's credentials that are missing, not the merchant's", () => {
    // An issue the merchant cannot act on is noise. Without platform Stripe
    // credentials the store cannot connect anything, and telling them to try is
    // a task with no completion — the same rule that keeps a missing email
    // provider off this list.
    expect(
      codes(storeFindings(store({ taxProvider: "stripe", stripeConfigured: false, stripeConnected: false }))),
    ).not.toContain("STRIPE_TAX_WITHOUT_CONNECTION");
  });

  it("does not confuse the two tax providers' failures", () => {
    const manual = codes(storeFindings(store({ taxProvider: "manual", manualTaxRateCount: 0 })));
    expect(manual).not.toContain("STRIPE_TAX_WITHOUT_CONNECTION");
    const stripe = codes(
      storeFindings(store({ taxProvider: "stripe", stripeConfigured: true, stripeConnected: false })),
    );
    expect(stripe).not.toContain("MANUAL_TAX_WITHOUT_RATES");
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

  it("flags an unverified sending domain without overstating it", () => {
    /**
     * Receipts **do** send without a verified domain — from the storefront's
     * Markii address (D44) — so this is a quality issue, not an outage. Calling
     * it critical would be the fabricated-urgency version of the same mistake
     * as fabricated success, and it teaches merchants to discount the list.
     */
    const live = storeFindings(store({ status: "live", customerEmailReady: false }));
    const found = live.find((f) => f.code === "UNVERIFIED_SENDING_DOMAIN");
    expect(found?.severity).toBe("warning");
    expect(found?.expectedImpact, "must not claim mail is failing").toMatch(/are sending/);

    const draft = storeFindings(store({ status: "draft", customerEmailReady: false }));
    expect(draft.find((f) => f.code === "UNVERIFIED_SENDING_DOMAIN")?.severity).toBe("opportunity");
  });

  it("stays silent when email is Markii's problem rather than the merchant's", () => {
    // No SES on the deployment means nothing the merchant does will help, and a
    // finding they cannot act on is noise — the same rule every other finding
    // here is held to.
    const found = storeFindings(
      store({ status: "live", emailProviderConfigured: false, customerEmailReady: false }),
    );
    expect(codes(found)).not.toContain("UNVERIFIED_SENDING_DOMAIN");
  });

  it("says nothing once a sending domain is verified", () => {
    expect(codes(storeFindings(store({ status: "live" })))).not.toContain(
      "UNVERIFIED_SENDING_DOMAIN",
    );
  });

  it("tells an unverified domain apart from no domain at all", () => {
    /**
     * A merchant one DNS record short has done the work. Telling them to
     * "connect a domain you own" when they already tried is the kind of advice
     * that teaches people to ignore the list — and the pending case is the more
     * urgent of the two, because anyone visiting the domain reaches nothing.
     */
    const pending = storeFindings(
      store({ customDomain: "shop.example.test", domainStatus: "pending" }),
    );
    expect(codes(pending)).toContain("DOMAIN_NOT_VERIFIED");
    expect(codes(pending)).not.toContain("NO_CUSTOM_DOMAIN");

    const none = storeFindings(store({ customDomain: null, domainStatus: "none" }));
    expect(codes(none)).toContain("NO_CUSTOM_DOMAIN");
    expect(codes(none)).not.toContain("DOMAIN_NOT_VERIFIED");

    const verified = storeFindings(store({ domainStatus: "verified" }));
    expect(codes(verified)).not.toContain("DOMAIN_NOT_VERIFIED");
    expect(codes(verified)).not.toContain("NO_CUSTOM_DOMAIN");
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
        domainStatus: "none",
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
