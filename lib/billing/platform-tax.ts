import type { BillingAddress } from "../db";
import { billingConfigured, platformTaxSettings, type PlatformTaxSettings } from "./stripe-billing";

/**
 * Whether Stripe Tax can be applied to **Markii's own** subscription for a
 * merchant (G3) — the pure decision, separate from the Stripe calls.
 *
 * This is the opposite direction of money from §18.6. There, the merchant is
 * the seller of record and their registrations decide what a shopper owes.
 * Here Markii is the seller, the merchant is the customer, and the two facts
 * that decide anything are whether Stripe Tax is switched on for the platform
 * account and whether the merchant has told us where they are.
 *
 * Both are reported, never merged: "not taxed because the platform has not
 * activated Tax" is Markii's problem to fix and "not taxed because no address
 * is on file" is the merchant's, and one flag would send the wrong person to
 * fix it.
 */

export type PlatformTaxApplication =
  | { applies: true; reason: "active" }
  | { applies: false; reason: "billing_not_configured" | "tax_not_active" | "no_billing_address" };

/**
 * What Stripe needs to locate a customer: a country and a postal code. City
 * and state are inferred from the postal code where that is possible, and
 * required by the schema only where it is not (`billingAddressSchema`).
 */
export function addressLocatable(address: BillingAddress | null | undefined): address is BillingAddress {
  return Boolean(address && address.country.length === 2 && address.postalCode.trim().length > 0);
}

export function platformTaxApplication(input: {
  billingConfigured: boolean;
  settings: PlatformTaxSettings | null;
  address: BillingAddress | null | undefined;
}): PlatformTaxApplication {
  if (!input.billingConfigured) return { applies: false, reason: "billing_not_configured" };
  if (!input.settings || input.settings.status !== "active") {
    return { applies: false, reason: "tax_not_active" };
  }
  if (!addressLocatable(input.address)) return { applies: false, reason: "no_billing_address" };
  return { applies: true, reason: "active" };
}

/** Copy for each state, written once so the action and the read cannot describe it differently. */
export function describePlatformTax(application: PlatformTaxApplication): string {
  switch (application.reason) {
    case "active":
      return "Sales tax on your Markii subscription is calculated from your billing address.";
    case "no_billing_address":
      return "No billing address on file — your Markii subscription is invoiced without sales tax until you add one.";
    case "tax_not_active":
      return "Stripe Tax is not active on Markii's account, so no tax is calculated on subscriptions yet.";
    case "billing_not_configured":
      return "Stripe Billing is not connected on this deployment.";
  }
}

/**
 * The application for an org, asking Stripe for the platform's Tax status.
 *
 * A failed settings read is treated as "not active" and **said so in
 * `settingsError`** rather than thrown: a preview or a billing screen must not
 * 500 because one status call failed, but it also must not silently render as
 * if Tax were off by choice.
 */
export async function resolvePlatformTax(
  address: BillingAddress | null | undefined,
): Promise<{ application: PlatformTaxApplication; settingsError: string | null }> {
  if (!billingConfigured()) {
    return {
      application: platformTaxApplication({ billingConfigured: false, settings: null, address }),
      settingsError: null,
    };
  }
  const settings = await platformTaxSettings();
  return {
    application: platformTaxApplication({
      billingConfigured: true,
      settings: settings.ok ? settings.settings : null,
      address,
    }),
    settingsError: settings.ok ? null : settings.message,
  };
}
