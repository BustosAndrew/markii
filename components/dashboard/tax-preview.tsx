"use client";

import { useState } from "react";
import { previewTax, type TaxPreview } from "@/lib/api/tax-shipping";
import { currencyExponent, formatMinor } from "@/lib/api/money";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

function parseDecimalToMinor(value: string, currency: string): number | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return null;
  const exponent = currencyExponent(currency);
  if (exponent === 0) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > exponent) return null;
  const minor =
    Number(whole) * 10 ** exponent + Number(frac.padEnd(exponent, "0").slice(0, exponent));
  if (!Number.isFinite(minor) || minor < 0) return null;
  return minor;
}

function previewBadge(state: TaxPreview["state"]): {
  variant: "success" | "warning" | "neutral";
  label: string;
} {
  if (state === "calculated") return { variant: "success", label: "calculated" };
  if (state === "none") return { variant: "neutral", label: "no tax" };
  return { variant: "warning", label: "not configured" };
}

export function TaxPreviewPanel({
  siteId,
  currency,
  billedByStripe = false,
}: {
  siteId: number;
  currency: string;
  /** True when the saved provider is Stripe Tax — this preview is a billed call. */
  billedByStripe?: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [shipping, setShipping] = useState("");
  const [taxCode, setTaxCode] = useState("");
  const [previewCurrency, setPreviewCurrency] = useState(currency);
  const [country, setCountry] = useState("US");
  const [province, setProvince] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [result, setResult] = useState<TaxPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resultCurrency = result?.currency || previewCurrency || currency;
  const badge = result ? previewBadge(result.state) : null;

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Preview tax</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Checkout recalculates from the cart. This is only a configuration preview.
            {billedByStripe
              ? " Stripe bills your account for each run, so it stays behind this button."
              : ""}
          </p>
        </div>
        {badge ? (
          <Badge variant={badge.variant}>{badge.label}</Badge>
        ) : (
          <Badge variant="info">Preview only</Badge>
        )}
      </div>

      <form
        className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const code = previewCurrency.trim().toUpperCase() || currency;
          const amountMinor = parseDecimalToMinor(amount, code);
          if (amountMinor === null) {
            setError("Enter a valid amount.");
            return;
          }
          const shippingTrimmed = shipping.trim();
          const shippingMinor = shippingTrimmed
            ? parseDecimalToMinor(shippingTrimmed, code)
            : undefined;
          if (shippingTrimmed && shippingMinor === null) {
            setError("Enter a valid shipping amount, or leave it blank.");
            return;
          }
          if (!country.trim()) {
            setError("Country is required.");
            return;
          }
          setBusy(true);
          setError(null);
          try {
            setResult(
              await previewTax({
                siteId,
                amountMinor,
                shippingMinor: shippingMinor ?? undefined,
                taxCode: taxCode.trim() || null,
                currency: code,
                address: {
                  country: country.trim().toUpperCase(),
                  province: province.trim() || null,
                  postalCode: postalCode.trim() || null,
                },
              }),
            );
          } catch (previewError) {
            setError(publicErrorMessage(previewError, "Tax preview failed."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <Label htmlFor="tax-preview-amount">Amount ({previewCurrency || currency})</Label>
          <Input
            id="tax-preview-amount"
            value={amount}
            inputMode="decimal"
            disabled={busy}
            placeholder="49.99"
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tax-preview-shipping">Shipping (optional)</Label>
          <Input
            id="tax-preview-shipping"
            value={shipping}
            inputMode="decimal"
            disabled={busy}
            placeholder="5.00"
            onChange={(event) => setShipping(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tax-preview-tax-code">Tax code (optional)</Label>
          <Input
            id="tax-preview-tax-code"
            value={taxCode}
            disabled={busy}
            placeholder="txcd_…"
            onChange={(event) => setTaxCode(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tax-preview-currency">Currency</Label>
          <Input
            id="tax-preview-currency"
            value={previewCurrency}
            disabled={busy}
            className="uppercase"
            onChange={(event) => setPreviewCurrency(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tax-preview-country">Country</Label>
          <Input
            id="tax-preview-country"
            value={country}
            disabled={busy}
            placeholder="US"
            className="uppercase"
            onChange={(event) => setCountry(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tax-preview-province">Province</Label>
          <Input
            id="tax-preview-province"
            value={province}
            disabled={busy}
            placeholder="CA"
            className="uppercase"
            onChange={(event) => setProvince(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tax-preview-postal">Postal code</Label>
          <Input
            id="tax-preview-postal"
            value={postalCode}
            disabled={busy}
            placeholder="94105"
            onChange={(event) => setPostalCode(event.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            {busy ? "Previewing…" : "Run preview"}
          </Button>
        </div>
      </form>

      {error ? <FieldError>{error}</FieldError> : null}

      {result ? (
        <div className="mt-5 rounded-[var(--radius-control)] border border-border p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted">Tax amount</dt>
              <dd className="tabular-nums text-foreground">
                {formatMinor(result.amountMinor, resultCurrency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Taxable base</dt>
              <dd className="tabular-nums text-foreground">
                {formatMinor(result.taxableBaseMinor, resultCurrency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Total</dt>
              <dd className="tabular-nums text-foreground">
                {formatMinor(result.totalMinor, resultCurrency)}
              </dd>
            </div>
          </dl>

          {result.note ? <p className="mt-3 text-sm text-muted">{result.note}</p> : null}

          {result.breakdown.length > 0 ? (
            <ul className="mt-4 space-y-2 text-sm">
              {result.breakdown.map((item, index) => (
                <li key={`${item.name}-${index}`} className="flex justify-between gap-4">
                  <span className="text-muted">
                    {item.name + ` (${(item.rateBps / 100).toFixed(2)}%)`}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {formatMinor(item.amountMinor, resultCurrency)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
