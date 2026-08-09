import { invokeAction } from "./actions";
import { apiGet } from "./client";
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

export type TaxSettings = {
  siteId: number;
  provider: TaxProvider;
  pricesIncludeTax: boolean;
  manualRates: ManualTaxRate[];
  defaultTaxCode: string | null;
  registrations: unknown[];
  operational: { ok: true } | { ok: false; reason: string };
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
