import { decimalMinor } from "@/lib/api/money";

/**
 * A price for display — the one definition every storefront surface shares
 * (`lib/generators.ts` re-exports it), kept with the drawing code so a page
 * reads the same price wherever it is rendered. `cents` is the currency's own
 * minor unit (D50).
 */
export function formatPrice(cents: number, currency: string): string {
  const value = decimalMinor(cents, currency);
  return currency === "USD" || currency === "USDC" ? `$${value}` : `${value} ${currency}`;
}
