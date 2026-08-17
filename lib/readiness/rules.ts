import { createHash } from "node:crypto";
import type { ComponentKey, Severity } from "./types";

/**
 * The readiness rules (§9) — pure functions over catalog facts.
 *
 * Everything here is deterministic: the same catalog produces the same issues
 * and the same score, every time. That is what lets a merchant be told *why*
 * their score moved, and it is the reason no model is involved (`docs/PRICING.md`
 * §"Margin check" — per-product inference would cost more than every other
 * infrastructure line combined).
 *
 * **A rule may only check a field this platform actually offers.** The §11
 * agent-data extension (`useCases`, `faqs`, `machineSummary`, GTIN, dimensions,
 * compatibility) is Phase E and does not exist, so nothing here scores a
 * merchant on it. Marking someone down for a field they have no way to fill
 * would be a fabricated criticism — the same rule that forbids fabricated
 * metrics (`CLAUDE.md`).
 */

export type RuleFinding = {
  code: string;
  severity: Severity;
  component: ComponentKey;
  title: string;
  affectedFields: string[];
  evidence: { field: string; current: string | null; expected: string }[];
  recommendation: string;
  expectedImpact: string;
  scope: { siteId: number | null; productId: number | null; categoryId: number | null };
};

/**
 * A stable id for a finding.
 *
 * Derived from the rule and what it is about, never from a counter or a
 * timestamp, because issues are **recomputed from the catalog on every request**
 * rather than stored. A merchant who dismisses "no images on product 9" must
 * still have it dismissed tomorrow, and that only works if tomorrow's run
 * produces the same id.
 */
export function issueId(
  code: string,
  scope: { siteId: number | null; productId: number | null; categoryId: number | null },
): string {
  const key = `${code}|${scope.siteId ?? ""}|${scope.productId ?? ""}|${scope.categoryId ?? ""}`;
  return `iss_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Product rules
// ---------------------------------------------------------------------------

export type ProductFacts = {
  id: number;
  siteId: number | null;
  categoryId: number | null;
  name: string;
  description: string | null;
  priceCents: number;
  sku: string | null;
  images: string[];
  enabled: boolean;
  /** Variants, when the product has migrated to them. */
  variants: { id: number; sku: string | null; barcode: string | null; weightGrams: number | null; requiresShipping: boolean }[];
  /** Legacy per-product counter, used only when there are no variants. */
  stock: number;
  /** Available-to-sell across variants, when there are any. */
  variantStock: number | null;
};

/** How short a description has to be before an agent has little to retrieve on. */
export const SHORT_DESCRIPTION_CHARS = 120;

export function productFindings(p: ProductFacts): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const scope = { siteId: p.siteId, productId: p.id, categoryId: p.categoryId };

  // A disabled product is not for sale, so it is not a readiness problem. Scoring
  // drafts would make a tidy catalog look worse than a neglected one.
  if (!p.enabled) return findings;

  const description = p.description?.trim() ?? "";
  if (description.length === 0) {
    findings.push({
      code: "MISSING_DESCRIPTION",
      severity: "critical",
      component: "product_data",
      title: `"${p.name}" has no description`,
      affectedFields: ["description"],
      evidence: [{ field: "description", current: null, expected: "A description of the product" }],
      recommendation:
        "Write a description covering what the product is, who it is for, and what is included.",
      expectedImpact:
        "An agent has nothing to match a shopper's request against, so this product is unlikely " +
        "to be retrieved at all.",
      scope,
    });
  } else if (description.length < SHORT_DESCRIPTION_CHARS) {
    findings.push({
      code: "SHORT_DESCRIPTION",
      severity: "warning",
      component: "product_data",
      title: `"${p.name}" has a very short description`,
      affectedFields: ["description"],
      evidence: [
        {
          field: "description",
          current: `${description.length} characters`,
          expected: `at least ${SHORT_DESCRIPTION_CHARS} characters`,
        },
      ],
      recommendation: "Add materials, dimensions, what is in the box, and who it suits.",
      expectedImpact: "Gives an agent more to match against when comparing similar products.",
      scope,
    });
  }

  if (p.images.length === 0) {
    findings.push({
      code: "NO_IMAGES",
      severity: "critical",
      component: "product_data",
      title: `"${p.name}" has no images`,
      affectedFields: ["images"],
      evidence: [{ field: "images", current: "0 images", expected: "at least one image" }],
      recommendation: "Add at least one product image.",
      expectedImpact:
        "JSON-LD emits no image, which several agent shopping surfaces require before they will " +
        "show a product.",
      scope,
    });
  }

  if (p.priceCents <= 0) {
    findings.push({
      code: "PRICE_NOT_SET",
      severity: "critical",
      component: "product_data",
      title: `"${p.name}" has no price`,
      affectedFields: ["priceCents"],
      evidence: [{ field: "priceCents", current: String(p.priceCents), expected: "greater than 0" }],
      recommendation: "Set a price, or disable the product until it has one.",
      expectedImpact: "An agent cannot quote or buy this, and it may be filtered out as invalid.",
      scope,
    });
  }

  // Identifiers. A missing SKU is the merchant's own inventory problem; a
  // missing barcode is what stops an agent matching this to the same product
  // elsewhere. Neither blocks a sale, so neither is critical.
  const hasSku = p.variants.length > 0 ? p.variants.every((v) => v.sku) : Boolean(p.sku);
  if (!hasSku) {
    findings.push({
      code: "MISSING_SKU",
      severity: "warning",
      component: "product_data",
      title: `"${p.name}" has no SKU`,
      affectedFields: ["sku"],
      evidence: [{ field: "sku", current: null, expected: "a unique code you use for this item" }],
      recommendation: "Add a SKU to the product or to each of its variants.",
      expectedImpact: "Makes orders and stock easier to reconcile against your own records.",
      scope,
    });
  }

  if (p.variants.length > 0 && p.variants.every((v) => !v.barcode)) {
    findings.push({
      code: "MISSING_BARCODE",
      severity: "opportunity",
      component: "product_data",
      title: `"${p.name}" has no barcode or GTIN`,
      affectedFields: ["barcode"],
      evidence: [{ field: "barcode", current: null, expected: "GTIN, EAN, UPC or ISBN" }],
      recommendation: "Add the barcode from the packaging to each variant.",
      expectedImpact:
        "Lets an agent recognise this as the same product it has seen elsewhere, rather than an " +
        "unknown listing.",
      scope,
    });
  }

  // Weight is what a shipping quote is built from. Only flag it where it would
  // actually be used — a download has no weight, and asking for one is noise.
  const shippable = p.variants.filter((v) => v.requiresShipping);
  if (shippable.length > 0 && shippable.every((v) => v.weightGrams == null)) {
    findings.push({
      code: "MISSING_WEIGHT",
      severity: "warning",
      component: "product_data",
      title: `"${p.name}" has no shipping weight`,
      affectedFields: ["weightGrams"],
      evidence: [{ field: "weightGrams", current: null, expected: "weight in grams" }],
      recommendation: "Set a weight on each variant that ships.",
      expectedImpact:
        "Weight-based shipping rates cannot apply to this product, so it may be quoted the wrong " +
        "postage or none at all.",
      scope,
    });
  }

  // Stock. Variant-backed products read the ledger; the rest still read the
  // legacy counter, and that difference is itself worth surfacing.
  const available = p.variantStock ?? p.stock;
  if (available <= 0) {
    findings.push({
      code: "OUT_OF_STOCK",
      severity: "warning",
      component: "inventory",
      title: `"${p.name}" is listed but out of stock`,
      affectedFields: ["stock"],
      evidence: [{ field: "stock", current: String(available), expected: "greater than 0" }],
      recommendation: "Restock it, or disable the product while it is unavailable.",
      expectedImpact:
        "An agent can find and attempt to buy this, then be refused at checkout — a worse " +
        "outcome than not listing it.",
      scope,
    });
  }

  if (p.variants.length === 0) {
    findings.push({
      code: "UNTRACKED_INVENTORY",
      severity: "opportunity",
      component: "inventory",
      title: `"${p.name}" does not use tracked inventory`,
      affectedFields: ["variants"],
      evidence: [
        { field: "variants", current: "0 variants", expected: "at least one variant" },
      ],
      recommendation: "Add a variant so stock moves through the inventory ledger.",
      expectedImpact:
        "Stock is a plain counter rather than an auditable ledger, and cannot be reserved during " +
        "checkout — so the last unit can be sold twice.",
      scope,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Store rules
// ---------------------------------------------------------------------------

export type StoreFacts = {
  id: number;
  name: string;
  status: "draft" | "live" | "paused";
  indexed: boolean;
  agentDiscovery: boolean;
  purchasesEnabled: boolean;
  paymentProviders: { x402?: boolean; stripe?: boolean };
  walletAddress: string | null;
  /** Falls back to the org's default wallet when the site has none. */
  orgWalletAddress: string | null;
  customDomain: string | null;
  /** A claim is not a connection — only `verified` routes (§2, migration 0031). */
  domainStatus: "none" | "pending" | "verified";
  enabledProductCount: number;
  /** True when anything on the store needs shipping — the trigger for rate rules. */
  sellsShippable: boolean;
  shippingZoneCount: number;
  /** Zones that exist but quote nothing, which silently refuses checkout. */
  emptyShippingZoneCount: number;
  taxProvider: "none" | "manual" | "stripe";
  manualTaxRateCount: number;
  /** Stock locations. Variant-backed products cannot be reserved without one. */
  locationCount: number;
  hasVariantBackedProducts: boolean;
  /** Whether Markii's own Stripe credentials exist in this environment. */
  stripeConfigured: boolean;
  /**
   * Whether AWS SES is connected on this deployment. When false, customer email
   * is **Markii's** problem and no finding is raised — an issue the merchant
   * cannot act on is noise, and this list only carries their tasks.
   */
  emailProviderConfigured: boolean;
  /** Whether the org has a **verified** sending domain of its own (§24). */
  customerEmailReady: boolean;
};

export function storeFindings(s: StoreFacts): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const scope = { siteId: s.id, productId: null, categoryId: null };

  // ---- checkout ----

  const rails = [s.paymentProviders.x402, s.paymentProviders.stripe].filter(Boolean).length;
  if (rails === 0) {
    findings.push({
      code: "NO_PAYMENT_RAIL",
      severity: "critical",
      component: "checkout",
      title: "No payment method is enabled",
      affectedFields: ["paymentProviders"],
      evidence: [{ field: "paymentProviders", current: "none enabled", expected: "at least one" }],
      recommendation: "Enable a payment method in the store's settings.",
      expectedImpact: "Nothing on this store can be bought, by an agent or a person.",
      scope,
    });
  }

  if (s.paymentProviders.x402 && !s.walletAddress && !s.orgWalletAddress) {
    findings.push({
      code: "NO_WALLET",
      severity: "critical",
      component: "checkout",
      title: "x402 is enabled but there is no receiving wallet",
      affectedFields: ["walletAddress"],
      evidence: [{ field: "walletAddress", current: null, expected: "a receiving address" }],
      recommendation: "Add a wallet address to the store, or set an organization default.",
      expectedImpact: "Every x402 checkout is refused, because there is nowhere to send payment.",
      scope,
    });
  }

  if (s.paymentProviders.stripe && !s.stripeConfigured) {
    findings.push({
      code: "CARD_RAIL_UNAVAILABLE",
      severity: "warning",
      component: "checkout",
      title: "Card payments are switched on but not available yet",
      affectedFields: ["paymentProviders"],
      evidence: [
        { field: "paymentProviders.stripe", current: "enabled", expected: "a connected account" },
      ],
      recommendation: "Connect a Stripe account, or turn card payments off until you have one.",
      expectedImpact:
        "A shopper choosing card is refused at the last step. Markii never holds your funds; " +
        "Stripe's fee is Stripe's.",
      scope,
    });
  }

  if (!s.purchasesEnabled && s.status === "live") {
    findings.push({
      code: "PURCHASES_DISABLED",
      severity: "critical",
      component: "checkout",
      title: "The store is live but purchases are switched off",
      affectedFields: ["purchasesEnabled"],
      evidence: [{ field: "purchasesEnabled", current: "false", expected: "true" }],
      recommendation: "Turn purchases on, or move the store back to draft while you work on it.",
      expectedImpact: "Agents and shoppers can browse but cannot buy.",
      scope,
    });
  }

  // ---- policies (shipping and tax configuration) ----

  if (s.sellsShippable && s.shippingZoneCount === 0) {
    findings.push({
      code: "NO_SHIPPING_ZONE",
      severity: "critical",
      component: "policies",
      title: "This store sells shippable goods but has no shipping zones",
      affectedFields: ["shippingZones"],
      evidence: [{ field: "shippingZones", current: "0 zones", expected: "at least one zone" }],
      recommendation: "Add a shipping zone and at least one rate.",
      expectedImpact:
        "Checkout is refused rather than quoting zero postage — which would leave you paying the " +
        "shipping cost silently.",
      scope,
    });
  }

  if (s.emptyShippingZoneCount > 0) {
    findings.push({
      code: "SHIPPING_ZONE_WITHOUT_RATES",
      severity: "critical",
      component: "policies",
      title: `${s.emptyShippingZoneCount} shipping zone(s) have no rates`,
      affectedFields: ["shippingRates"],
      evidence: [
        {
          field: "shippingRates",
          current: `${s.emptyShippingZoneCount} empty zone(s)`,
          expected: "every zone has at least one rate",
        },
      ],
      recommendation: "Add a rate to each zone, or delete the zones you do not ship to.",
      expectedImpact:
        "An empty zone looks configured but refuses every checkout to the destinations it covers.",
      scope,
    });
  }

  if (s.taxProvider === "manual" && s.manualTaxRateCount === 0) {
    findings.push({
      code: "MANUAL_TAX_WITHOUT_RATES",
      severity: "critical",
      component: "policies",
      title: "Tax is set to manual but no rates are configured",
      affectedFields: ["taxSettings"],
      evidence: [{ field: "manualRates", current: "0 rates", expected: "at least one rate" }],
      recommendation: "Add a tax rate for each place you are registered, or set tax to none.",
      expectedImpact: "Every checkout is refused for having no calculable tax.",
      scope,
    });
  }

  // ---- inventory ----

  if (s.hasVariantBackedProducts && s.locationCount === 0) {
    findings.push({
      code: "NO_STOCK_LOCATION",
      severity: "critical",
      component: "inventory",
      title: "This store has no stock location",
      affectedFields: ["locations"],
      evidence: [{ field: "locations", current: "0 locations", expected: "at least one" }],
      recommendation: "Create a location for the store.",
      expectedImpact:
        "Stock cannot be reserved during checkout, so products with variants cannot be sold.",
      scope,
    });
  }

  // ---- protocol coverage ----

  if (!s.agentDiscovery) {
    findings.push({
      code: "AGENT_DISCOVERY_OFF",
      severity: "critical",
      component: "protocol_coverage",
      title: "Agent discovery is switched off",
      affectedFields: ["agentDiscovery"],
      evidence: [{ field: "agentDiscovery", current: "false", expected: "true" }],
      recommendation: "Turn agent discovery on in the store's settings.",
      expectedImpact:
        "llms.txt and agent.md are not served, so agents have no machine-readable description of " +
        "this store — the thing Markii exists to provide.",
      scope,
    });
  }

  if (s.status === "live" && !s.indexed) {
    findings.push({
      code: "NOT_INDEXED",
      severity: "warning",
      component: "protocol_coverage",
      title: "The store is live but asks not to be indexed",
      affectedFields: ["indexed"],
      evidence: [{ field: "indexed", current: "false", expected: "true" }],
      recommendation: "Allow indexing unless you are deliberately running a private store.",
      expectedImpact: "Crawlers are asked to skip the store, so it is unlikely to be found.",
      scope,
    });
  }

  if (s.status !== "live") {
    findings.push({
      code: "STORE_NOT_LIVE",
      severity: "warning",
      component: "protocol_coverage",
      title: `The store is ${s.status}`,
      affectedFields: ["status"],
      evidence: [{ field: "status", current: s.status, expected: "live" }],
      recommendation: "Publish the store when you are ready to sell.",
      expectedImpact:
        "Nothing here is publicly reachable yet. Everything else on this list is worth fixing " +
        "before you publish.",
      scope,
    });
  }

  if (s.enabledProductCount === 0) {
    findings.push({
      code: "NO_PRODUCTS",
      severity: "critical",
      component: "product_data",
      title: "The store has no products for sale",
      affectedFields: ["products"],
      evidence: [{ field: "products", current: "0 enabled", expected: "at least one" }],
      recommendation: "Add a product, or enable one you have already created.",
      expectedImpact: "There is nothing for an agent to find or buy.",
      scope,
    });
  }

  /**
   * **A store that cannot email its customers is selling blind.**
   *
   * Order confirmations, shipping and refund notices, and digital delivery all
   * refuse without the merchant's own verified sending domain — there is no
   * fallback to `markii.shop` for them (G1). So a shopper can buy and receive
   * *nothing*: no receipt, no tracking, and for a digital product, not even the
   * file they paid for.
   *
   * Shopper **account** mail is the one exception and does still send, from the
   * storefront's own subdomain (§24) — which is exactly why this needs saying
   * out loud. A merchant who watched a signup confirmation arrive has every
   * reason to assume receipts work too.
   *
   * Critical once live, because by then real buyers are affected. A warning
   * before that: it is a go-live blocker rather than a live emergency.
   */
  if (s.emailProviderConfigured && !s.customerEmailReady) {
    findings.push({
      code: "UNVERIFIED_SENDING_DOMAIN",
      severity: s.status === "live" ? "warning" : "opportunity",
      component: "protocol_coverage",
      title: "Customer email does not come from your domain",
      affectedFields: ["emailIdentity"],
      evidence: [
        { field: "sendingDomain", current: `${s.name} on markii.shop`, expected: "a domain you own" },
      ],
      recommendation: "Verify a sending domain in Settings → Email.",
      /**
       * Not critical, and no longer "cannot email" — receipts **do** send, from
       * the storefront's Markii address (D44). Overstating this would train
       * merchants to discount the list, and the list only works if every
       * critical really is one.
       */
      expectedImpact:
        "Receipts and delivery emails are sending, but from a markii.shop address rather than " +
        "yours. Your own domain looks like you to buyers, and its sending reputation is yours " +
        "rather than shared with every other store.",
      scope,
    });
  }

  /**
   * A pending domain reads as its own finding rather than as "no domain". The
   * merchant has done the work and is one DNS record short — telling them to
   * "connect a domain you own" when they already tried is the kind of advice
   * that teaches people to ignore the list.
   */
  if (s.domainStatus === "pending" && s.customDomain) {
    findings.push({
      code: "DOMAIN_NOT_VERIFIED",
      severity: "warning",
      component: "protocol_coverage",
      title: `${s.customDomain} is connected but not verified`,
      affectedFields: ["customDomain"],
      evidence: [{ field: "domainStatus", current: "pending", expected: "verified" }],
      recommendation:
        "Publish the TXT record shown in the site's domain settings, then check again.",
      expectedImpact:
        "The domain does not serve this storefront until it verifies. Anyone visiting it now " +
        "reaches nothing.",
      scope,
    });
  } else if (!s.customDomain) {
    findings.push({
      code: "NO_CUSTOM_DOMAIN",
      severity: "opportunity",
      component: "protocol_coverage",
      title: "The store has no custom domain",
      affectedFields: ["customDomain"],
      evidence: [{ field: "customDomain", current: null, expected: "your own domain" }],
      recommendation: "Connect a domain you own.",
      expectedImpact: "Your own domain is more recognisable to shoppers and to agents citing you.",
      scope,
    });
  }

  return findings;
}
