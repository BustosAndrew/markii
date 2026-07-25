const currencyDisplay: Record<string, string> = {
  USD: "USD",
  USDC: "USDC",
};

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
