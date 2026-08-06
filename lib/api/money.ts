const currencyDisplay: Record<string, string> = {
  USD: "USD",
  USDC: "USDC",
};

/**
 * Codes `Intl` cannot resolve as ISO 4217. Markii denominates USDC in
 * 2-decimal minor units; `lib/x402.ts` converts that to the token's 6-decimal
 * base units at payment time.
 */
const NON_ISO_EXPONENTS: Record<string, number> = { USDC: 2 };

const FALLBACK_EXPONENT = 2;

/**
 * Minor-unit digits for a currency, derived from the currency itself — JPY and
 * KRW have none, and billing currency is merchant-set (D31). Never assume 2.
 */
export function currencyExponent(currency: string, locale = "en-US"): number {
  const code = currency.toUpperCase();
  const override = NON_ISO_EXPONENTS[code];
  if (override !== undefined) {
    return override;
  }

  try {
    const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
    }).resolvedOptions();
    return maximumFractionDigits ?? FALLBACK_EXPONENT;
  } catch {
    return FALLBACK_EXPONENT;
  }
}

/**
 * Format an integer minor-unit amount (`*Minor` fields, API §16 onward).
 * Scaling happens once, here, against the currency's own exponent — callers
 * must never divide by 100 or pin `minimumFractionDigits` (D31).
 */
export function formatMinor(
  amountMinor: number,
  currency: string,
  locale = "en-US",
): string {
  const code = currency.toUpperCase();
  const exponent = currencyExponent(code, locale);
  const amount = amountMinor / 10 ** exponent;
  const digits = {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  };

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      ...digits,
    }).format(amount);
  } catch {
    // Not an ISO 4217 code (USDC) — Intl rejects it, so suffix the code.
    return `${new Intl.NumberFormat(locale, digits).format(amount)} ${code}`;
  }
}

/**
 * The same amount as a **plain decimal string** — for CSV cells, accounting
 * imports, and anywhere a machine reads the number back.
 *
 * {@link formatMinor} is for humans and adds a symbol and grouping separators;
 * a `1,523.00` in a comma-separated file is two columns, and `$` is not a digit.
 *
 * The scaling is integer and string work, never `minor / 100`: the exponent is
 * the currency's (JPY has none, D31), and float division is exactly what the
 * money rule forbids.
 */
export function decimalMinor(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(amountMinor);
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, "0");
  const sign = amountMinor < 0 ? "-" : "";
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * Legacy `*Cents` fields from API §1–8 only, which are USD/USDC-shaped by
 * design. Anything with a `Minor` suffix uses {@link formatMinor} (D31).
 */
export function formatCents(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  const amount = cents / 100;
  const code = currencyDisplay[currency] ?? currency;

  if (code === "USDC") {
    return `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)} USDC`;
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}
