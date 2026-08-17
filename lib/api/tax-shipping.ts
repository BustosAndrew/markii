import { invokeAction } from "./actions";
import { apiGet, apiPost } from "./client";
import { callWhenLive } from "./planned";

const SECTION = "API §18.6";
const LIVE = true;

export type TaxProvider = "none" | "manual" | "stripe";

export type ManualTaxRate = {
  country: string;
  province?: string | null;
  rateBps: number;
  name?: string | null;
};

/**
 * The three Stripe Tax facts, un-merged (§18.6, live 2026-08-17).
 *
 * **Render them separately.** They fail independently and want different
 * people: `platform` is Markii's credentials, `connected` and `status` are the
 * merchant's Stripe account, and `activeRegistrations` is the merchant again in
 * a different corner of the same dashboard. One combined tick sends a merchant
 * to fix the wrong thing — the same reason the domain status surface keeps
 * ownership, pointing, and platform apart.
 *
 * `activeRegistrations: 0` is the state most likely to be a mistake and least
 * likely to look like one: Stripe Tax with no registration calculates a real
 * zero everywhere, so the store charges nothing and appears to work. `null`
 * means the count could not be read — not that there are none.
 *
 * Null on any provider but `stripe`.
 */
export type StripeTaxFacts = {
  platform: boolean;
  connected: boolean;
  status: "active" | "pending" | "unknown" | "unavailable";
  /** Stripe's own words for what it still needs. Show them verbatim. */
  missing: string[];
  activeRegistrations: number | null;
  /** Present only when Stripe refused to answer at all. */
  error?: string;
};

export type TaxSettings = {
  siteId: number;
  provider: TaxProvider;
  pricesIncludeTax: boolean;
  manualRates: ManualTaxRate[];
  defaultTaxCode: string | null;
  registrations: unknown[];
  operational: { ok: true } | { ok: false; reason: string };
  /** Live as of 2026-08-17. Null unless `provider === "stripe"`. */
  stripeTax: StripeTaxFacts | null;
  configured: boolean;
  updatedAt: string | null;
  disclaimer: string;
};

export type ShippingRate = {
  id: number;
  zoneId: number;
  name: string;
  type: "flat" | "weight_based" | "price_based" | "free_over_threshold";
  priceMinor: number;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
  minSubtotalMinor?: number | null;
  maxSubtotalMinor?: number | null;
  freeOverMinor?: number | null;
  enabled: boolean;
  position: number;
};

export type ShippingZone = {
  id: number;
  siteId: number;
  name: string;
  countries: string[];
  provinces: string[];
  rates?: ShippingRate[];
  rateCount?: number;
  warning?: string | null;
};

export function getTaxSettings(siteId: number, init?: RequestInit) {
  return callWhenLive(LIVE, SECTION, () =>
    apiGet<TaxSettings>("/api/settings/tax", { siteId }, init),
  );
}

export function updateTaxSettings(
  body: {
    siteId: number;
    provider?: TaxProvider;
    pricesIncludeTax?: boolean;
    manualRates?: ManualTaxRate[];
    defaultTaxCode?: string | null;
    registrations?: unknown[];
  },
  init?: RequestInit,
) {
  return invokeAction("tax.updateSettings", body, init);
}

export function listShippingZones(siteId: number, init?: RequestInit) {
  return callWhenLive(LIVE, SECTION, () =>
    apiGet<{ items: ShippingZone[]; total: number }>(
      "/api/shipping/zones",
      { siteId },
      init,
    ),
  );
}

export function listShippingRates(
  query: { siteId: number; zoneId?: number },
  init?: RequestInit,
) {
  return callWhenLive(LIVE, SECTION, () =>
    apiGet<{
      items: (ShippingRate & { zone: { id: number; name: string; siteId: number } })[];
      total: number;
    }>("/api/shipping/rates", query, init),
  );
}

export function createShippingZone(
  body: {
    siteId: number;
    name: string;
    countries?: string[];
    provinces?: string[];
  },
  init?: RequestInit,
) {
  return invokeAction<ShippingZone>("shipping.createZone", body, init);
}

export function updateShippingZone(
  body: {
    zoneId: number;
    name?: string;
    countries?: string[];
    provinces?: string[];
  },
  init?: RequestInit,
) {
  return invokeAction<ShippingZone>("shipping.updateZone", body, init);
}

export function deleteShippingZone(body: { zoneId: number }, init?: RequestInit) {
  return invokeAction("shipping.deleteZone", body, init);
}

export function createShippingRate(
  body: {
    zoneId: number;
    name: string;
    type: ShippingRate["type"];
    priceMinor: number;
    minWeightGrams?: number | null;
    maxWeightGrams?: number | null;
    minSubtotalMinor?: number | null;
    maxSubtotalMinor?: number | null;
    freeOverMinor?: number | null;
    enabled?: boolean;
    position?: number;
  },
  init?: RequestInit,
) {
  return invokeAction<ShippingRate>("shipping.createRate", body, init);
}

export function updateShippingRate(
  body: { rateId: number } & Partial<
    Omit<ShippingRate, "id" | "zoneId">
  >,
  init?: RequestInit,
) {
  return invokeAction<ShippingRate>("shipping.updateRate", body, init);
}

export function deleteShippingRate(body: { rateId: number }, init?: RequestInit) {
  return invokeAction("shipping.deleteRate", body, init);
}

/**
 * `POST /api/tax/calculate` — what tax an amount and destination would attract.
 *
 * **A preview, never a charge.** It writes nothing and creates no obligation;
 * checkout does its own calculation from the cart, and this is never the source
 * of a number anyone is billed. It exists so a merchant can confirm their rates
 * behave as expected before a shopper is the one who finds out.
 *
 * Added 2026-08-10: the route had shipped with no typed caller, so no screen
 * could reach it. `/dashboard/settings/tax` is where it belongs.
 *
 * **Stripe Tax answers this now too** (2026-08-17). The response shape did not
 * change, but two things about it did: previewing a `stripe` store makes a real
 * Stripe API call the merchant is billed for, so do not fire it on every
 * keystroke; and the preview's calculation is deliberately never returned,
 * because a preview must not become the source of a tax transaction on the
 * merchant's filings.
 */
export type TaxPreview = {
  /** Zero when prices are tax-inclusive — the tax is already inside the base. */
  amountMinor: number;
  /**
   * Corrected 2026-08-17. This read `"address_required"`, which the route has
   * never returned — a missing address comes back as `not_configured` with the
   * reason in `note`. `"none"` was missing, and it is the *common* case: a store
   * on `provider: "none"` is not misconfigured, it has told us it collects no
   * tax, and a screen that renders it as a problem is wrong about every store
   * that has not set tax up.
   */
  state: "calculated" | "none" | "not_configured";
  /** True when the tax sits *inside* `taxableBaseMinor` rather than on top. */
  included: boolean;
  breakdown: { name: string; rateBps: number; amountMinor: number }[];
  /** Why the state is what it is. Always render it — it is the actionable half. */
  note?: string;
  taxableBaseMinor: number;
  /** Does not move when `included` — reported separately so that stays legible. */
  totalMinor: number;
  /** Read from the store's catalog when the caller does not pass one. */
  currency: string;
  preview: true;
};

export function previewTax(
  body: {
    siteId: number;
    amountMinor: number;
    /** Quoted apart from the goods: whether delivery is taxable is jurisdictional. */
    shippingMinor?: number;
    /** Stripe product tax code (`txcd_…`) to preview against. Stripe Tax only. */
    taxCode?: string | null;
    /** ISO 4217. Defaults to what the store's catalog sells in. */
    currency?: string | null;
    address: {
      line1?: string;
      city?: string;
      province?: string | null;
      postalCode?: string | null;
      /** ISO 3166-1 alpha-2. */
      country: string;
    };
  },
  init?: RequestInit,
) {
  return callWhenLive(LIVE, SECTION, () =>
    apiPost<TaxPreview>("/api/tax/calculate", body, init),
  );
}
