import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  carts,
  db,
  sites,
  taxSettings,
  type CartAddress,
  type ManualTaxRate,
  type TaxSettings,
} from "../db";
import { getIntegration } from "../integrations";
import { stripeConfigured } from "../payments";
import { createTaxCalculation, type StripeTaxLine } from "../payments/stripe-tax";

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
 *
 * The two providers meet at {@link TaxResult} and nowhere else. Everything a
 * caller sees — the states, the inclusive/exclusive meaning of `amountMinor`,
 * the breakdown shape — is identical whichever one answered, so checkout,
 * receipts, and the order record never branch on the provider.
 */

export type TaxResult = {
  amountMinor: number;
  state: "calculated" | "none" | "not_configured";
  note?: string;
  /** What was applied, for the shopper and for the merchant's records. */
  breakdown?: { name: string; rateBps: number; amountMinor: number }[];
  /** True when the tax is already inside the listed price rather than added. */
  included: boolean;
  /**
   * Stripe's `taxcalc_…`, on the Stripe path only.
   *
   * The caller must carry this to the checkout session and no further: it is
   * what the merchant's Stripe Tax transaction is created from once the payment
   * succeeds, and a sale recorded from the wrong calculation is a filing built
   * on someone else's basket.
   */
  calculationId?: string | null;
};

/** A line as the tax engines need it. Amounts are **before** discount. */
export type TaxableLine = {
  /** Stable within the cart, so a re-calculation matches line for line. */
  reference: string;
  amountMinor: number;
  quantity: number;
  /** The product's own Stripe tax code, if it carries one. */
  taxCode: string | null;
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
 * Everything that can change what Stripe answers, hashed.
 *
 * A cached calculation may only be reused for the identical question, so this
 * has to cover more than the total: the same £100 split across different tax
 * codes, or shipped to a different state, is a different tax. `settingsUpdatedAt`
 * is in here so a merchant switching `pricesIncludeTax` or adding a default tax
 * code invalidates every cached answer at once, without this function needing to
 * know which settings matter.
 *
 * Exported for the tests — a fingerprint that failed to notice a changed input
 * would show up as a stale tax charged to a shopper, and nowhere else.
 */
export function taxFingerprint(input: {
  lines: TaxableLine[];
  shippingMinor: number;
  currency: string;
  address: CartAddress | null;
  settings: TaxSettings;
}): string {
  const payload = JSON.stringify([
    input.currency.toUpperCase(),
    input.shippingMinor,
    input.lines.map((l) => [l.reference, l.amountMinor, l.quantity, l.taxCode ?? ""]),
    [
      input.address?.line1 ?? "",
      input.address?.city ?? "",
      input.address?.province ?? "",
      input.address?.postalCode ?? "",
      input.address?.country ?? "",
    ],
    input.settings.provider,
    input.settings.pricesIncludeTax,
    input.settings.defaultTaxCode ?? "",
    input.settings.updatedAt?.toISOString() ?? "",
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * Which Stripe account a store's tax is calculated on — the **merchant's**.
 *
 * They are the seller of record (G2), so their registrations decide the answer
 * and their account is billed for asking. Markii's own account would answer with
 * Markii's tax position, which is a different company's number entirely.
 */
async function merchantAccount(siteId: number): Promise<string | null> {
  const [site] = await db
    .select({ orgId: sites.orgId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  if (!site) return null;
  const connection = await getIntegration(site.orgId, "stripe");
  return connection?.status === "connected" ? (connection.config.accountId ?? null) : null;
}

/** The unconfigured Stripe answer, with the reason someone can act on. */
function stripeNotConfigured(pricesIncludeTax: boolean, note: string): TaxResult {
  return { amountMinor: 0, state: "not_configured", included: pricesIncludeTax, note };
}

/**
 * Stripe Tax, on the merchant's own connected account.
 *
 * **Cached on the cart when there is one.** Stripe bills the merchant for every
 * calculation and `priceCart` runs on each cart render, so an uncached path
 * would charge a merchant for a shopper reloading a page. A cache hit is only
 * ever the identical question — see {@link taxFingerprint} — and it is never
 * reused across carts, because a calculation converts into exactly one Stripe
 * Tax transaction and the second sale would go unrecorded.
 *
 * Every failure lands on `not_configured` and never on a zero. A zero here would
 * read as "no tax is due on this order", which is a statement about a merchant's
 * liability that a network error is in no position to make.
 */
async function stripeTax(input: {
  siteId: number;
  cartId: number | null;
  settings: TaxSettings;
  address: CartAddress | null;
  lines: TaxableLine[];
  shippingMinor: number;
  currency: string;
}): Promise<TaxResult> {
  const { settings } = input;

  if (!stripeConfigured()) {
    return stripeNotConfigured(
      settings.pricesIncludeTax,
      "Stripe Tax is selected but this platform has no Stripe credentials.",
    );
  }
  if (!input.address?.country) {
    return stripeNotConfigured(
      settings.pricesIncludeTax,
      "A shipping address is required before Stripe Tax can be calculated.",
    );
  }
  if (input.lines.length === 0) {
    return stripeNotConfigured(
      settings.pricesIncludeTax,
      "There is nothing to calculate tax on yet.",
    );
  }

  const accountId = await merchantAccount(input.siteId);
  if (!accountId) {
    return stripeNotConfigured(
      settings.pricesIncludeTax,
      "Stripe Tax is selected but this store is not connected to Stripe. Connect your Stripe " +
        "account in Settings → Payments — Stripe Tax runs on your own account, with your own " +
        "registrations.",
    );
  }

  const fingerprint = taxFingerprint({
    lines: input.lines,
    shippingMinor: input.shippingMinor,
    currency: input.currency,
    address: input.address,
    settings,
  });

  if (input.cartId != null) {
    const [cart] = await db
      .select({
        id: carts.taxCalculationId,
        fingerprint: carts.taxCalculationFingerprint,
        expiresAt: carts.taxCalculationExpiresAt,
        result: carts.taxCalculationResult,
      })
      .from(carts)
      .where(eq(carts.id, input.cartId))
      .limit(1);

    /**
     * An expired calculation is discarded rather than served. Stripe stops
     * accepting it as the source of a transaction after 90 days, so a cache hit
     * there would quote a tax that could never be recorded for filing — the
     * failure would surface at completion, after the shopper had paid.
     */
    const live = cart?.expiresAt == null || cart.expiresAt.getTime() > Date.now();
    if (cart?.result && cart.fingerprint === fingerprint && live) {
      return {
        amountMinor: cart.result.inclusive ? 0 : cart.result.taxAmountMinor,
        state: "calculated",
        included: cart.result.inclusive,
        breakdown: cart.result.breakdown,
        calculationId: cart.id,
        note: cart.result.inclusive
          ? `Includes ${cart.result.taxAmountMinor} of tax (prices are tax-inclusive).`
          : undefined,
      };
    }
  }

  const lines: StripeTaxLine[] = input.lines.map((l) => ({
    reference: l.reference,
    amountMinor: l.amountMinor,
    quantity: l.quantity,
    taxCode: l.taxCode,
  }));

  const calc = await createTaxCalculation({
    accountId,
    currency: input.currency,
    lines,
    shippingMinor: input.shippingMinor,
    address: {
      line1: input.address.line1,
      city: input.address.city,
      province: input.address.province,
      postalCode: input.address.postalCode,
      country: input.address.country,
    },
    pricesIncludeTax: settings.pricesIncludeTax,
    defaultTaxCode: settings.defaultTaxCode,
  });

  if (!calc.ok) {
    /**
     * Stripe's own message, unedited. "You must have an active registration in
     * California" tells a merchant what to do; "tax could not be calculated"
     * tells them nothing and sends them to support.
     */
    return stripeNotConfigured(
      settings.pricesIncludeTax,
      calc.code === "configuration_required"
        ? `Stripe Tax could not calculate: ${calc.reason}`
        : `Stripe Tax is temporarily unavailable: ${calc.reason}`,
    );
  }

  const taxAmountMinor = settings.pricesIncludeTax
    ? calc.taxAmountInclusiveMinor
    : calc.taxAmountExclusiveMinor;

  if (input.cartId != null) {
    await db
      .update(carts)
      .set({
        taxCalculationId: calc.calculationId,
        taxCalculationFingerprint: fingerprint,
        taxCalculationExpiresAt: calc.expiresAt,
        taxCalculationResult: {
          taxAmountMinor,
          inclusive: settings.pricesIncludeTax,
          breakdown: calc.breakdown,
        },
      })
      .where(eq(carts.id, input.cartId));
  }

  return {
    // An included tax is not added to the total — it is already in it.
    amountMinor: settings.pricesIncludeTax ? 0 : taxAmountMinor,
    state: "calculated",
    included: settings.pricesIncludeTax,
    breakdown: calc.breakdown,
    calculationId: calc.calculationId,
    note: settings.pricesIncludeTax
      ? `Includes ${taxAmountMinor} of tax (prices are tax-inclusive).`
      : undefined,
  };
}

/**
 * Calculates tax for a cart.
 *
 * The three unconfigured cases stay distinct. `none` means no tax line is added
 * and that is the merchant's stated position; `not_configured` means a provider
 * was chosen but cannot run, which is a gap someone must close — collapsing
 * either into a bare `0` tells the shopper something nobody established (D33).
 *
 * `taxableBaseMinor` drives the manual path and `lines` + `shippingMinor` drive
 * the Stripe one, and they are not interchangeable: a manual rate applies to a
 * single base, while Stripe decides per line and per jurisdiction whether
 * delivery is even taxable. A caller that supplies only a base gets `manual`
 * behaviour and an honest `not_configured` from `stripe`.
 */
export async function calculateTax(input: {
  siteId: number;
  address: CartAddress | null;
  taxableBaseMinor: number;
  settings?: TaxSettings;
  /**
   * The lines, **net of discount**, for the Stripe path. Discounts are
   * order-level and tax is charged on what is actually paid, so quoting Stripe
   * the pre-discount amounts would over-collect on every discounted order.
   */
  lines?: TaxableLine[];
  /** Quoted to Stripe separately: whether delivery is taxable is jurisdictional. */
  shippingMinor?: number;
  currency?: string;
  /** Where a Stripe calculation is cached. Null for a preview, which caches none. */
  cartId?: number | null;
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
    if (!input.currency) {
      return stripeNotConfigured(
        settings.pricesIncludeTax,
        "Stripe Tax needs a currency and line detail to calculate.",
      );
    }
    return stripeTax({
      siteId: input.siteId,
      cartId: input.cartId ?? null,
      settings,
      address: input.address,
      lines: input.lines ?? [],
      shippingMinor: input.shippingMinor ?? 0,
      currency: input.currency,
    });
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
