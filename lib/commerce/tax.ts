import { eq } from "drizzle-orm";
import { db, taxSettings, type CartAddress, type ManualTaxRate, type TaxSettings } from "../db";
import { stripeConfigured } from "../payments";

/**
 * Tax calculation (§18.6).
 *
 * **Markii never gives tax advice** (`docs/DECISIONS.md` G2). This applies what
 * the merchant configured; it does not decide what they owe, and it does not
 * infer a rate for a destination they have not set one for. Under Connect
 * Standard the merchant is the seller of record and the taxpayer.
 *
 * Stripe Tax is the decided provider (G3) and is the only one that scales past a
 * single jurisdiction. Manual rates exist because a merchant selling in one
 * state or one country should not need a Stripe Tax subscription to charge the
 * one rate they already know.
 */

export type TaxResult = {
  amountMinor: number;
  state: "calculated" | "none" | "not_configured";
  note?: string;
  /** What was applied, for the shopper and for the merchant's records. */
  breakdown?: { name: string; rateBps: number; amountMinor: number }[];
  /** True when the tax is already inside the listed price rather than added. */
  included: boolean;
};

/** Settings for a store, with the safe default for one that has never configured any. */
export async function taxSettingsFor(siteId: number): Promise<TaxSettings> {
  const [row] = await db.select().from(taxSettings).where(eq(taxSettings.siteId, siteId)).limit(1);
  return (
    row ?? {
      siteId,
      provider: "none" as const,
      // Matches how §18.4 has been quoting since D33: the listed price stands.
      pricesIncludeTax: true,
      manualRates: [],
      defaultTaxCode: null,
      registrations: [],
      updatedAt: new Date(),
    }
  );
}

/**
 * The merchant's rate for a destination, or null.
 *
 * Most specific wins — a province rate beats a country rate — for the same
 * reason shipping zones resolve that way: two matching rules whose winner
 * depends on row order is a rate that silently stops applying.
 */
export function rateFor(rates: ManualTaxRate[], address: CartAddress | null): ManualTaxRate | null {
  const country = address?.country?.toUpperCase();
  if (!country) return null;
  const province = address?.province?.toUpperCase() ?? null;

  const inCountry = rates.filter((r) => r.country.toUpperCase() === country);
  if (province) {
    const exact = inCountry.find((r) => r.province?.toUpperCase() === province);
    if (exact) return exact;
  }
  return inCountry.find((r) => !r.province) ?? null;
}

/**
 * Tax on a taxable base.
 *
 * Rounded half-up on an integer basis-point multiplication — no float math ever
 * touches the amount (`CLAUDE.md`, D31). `875` basis points on `1999` minor
 * units is `(1999 * 875 + 5000) / 10000 = 175`, computed entirely in integers.
 */
export function taxOn(baseMinor: number, rateBps: number): number {
  return Math.floor((baseMinor * rateBps + 5000) / 10000);
}

/**
 * Calculates tax for a cart.
 *
 * The three unconfigured cases stay distinct. `none` means no tax line is added
 * and that is the merchant's stated position; `not_configured` means a provider
 * was chosen but cannot run, which is a gap someone must close — collapsing
 * either into a bare `0` tells the shopper something nobody established (D33).
 */
export async function calculateTax(input: {
  siteId: number;
  address: CartAddress | null;
  taxableBaseMinor: number;
  settings?: TaxSettings;
}): Promise<TaxResult> {
  const settings = input.settings ?? (await taxSettingsFor(input.siteId));

  if (settings.provider === "none") {
    return {
      amountMinor: 0,
      state: "none",
      included: settings.pricesIncludeTax,
      note: settings.pricesIncludeTax
        ? "No separate tax line: this store's prices are configured as tax-inclusive."
        : "This store has not configured tax collection.",
    };
  }

  if (settings.provider === "stripe") {
    // Stripe Tax is the decided provider but there is no key in this
    // environment. Returning a calculated 0 would be a claim about a merchant's
    // tax liability made by code that never asked anyone.
    return {
      amountMinor: 0,
      state: "not_configured",
      included: settings.pricesIncludeTax,
      note: stripeConfigured()
        ? "Stripe Tax is selected but not yet available on this store."
        : "Stripe Tax is selected but card payments are not fully configured.",
    };
  }

  // provider === "manual"
  const rate = rateFor(settings.manualRates, input.address);
  if (!rate) {
    return {
      amountMinor: 0,
      state: "not_configured",
      included: settings.pricesIncludeTax,
      note: input.address?.country
        ? `This store has no tax rate configured for ${input.address.country}.`
        : "A shipping address is required before tax can be calculated.",
    };
  }

  /**
   * Tax-inclusive prices already contain the tax, so it is extracted from the
   * base rather than added to it: at rate `r`, the tax inside a price `p` is
   * `p × r / (1 + r)`. Adding it instead would charge the shopper twice.
   */
  const amountMinor = settings.pricesIncludeTax
    ? Math.floor((input.taxableBaseMinor * rate.rateBps + (10000 + rate.rateBps) / 2) /
        (10000 + rate.rateBps))
    : taxOn(input.taxableBaseMinor, rate.rateBps);

  return {
    // An included tax is not added to the total — it is already in it.
    amountMinor: settings.pricesIncludeTax ? 0 : amountMinor,
    state: "calculated",
    included: settings.pricesIncludeTax,
    breakdown: [{ name: rate.name, rateBps: rate.rateBps, amountMinor }],
    note: settings.pricesIncludeTax
      ? `Includes ${rate.name} of ${amountMinor} (prices are tax-inclusive).`
      : undefined,
  };
}
