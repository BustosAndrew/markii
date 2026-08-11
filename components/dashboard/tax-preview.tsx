"use client";

import { useState } from "react";
import { previewTax, type TaxPreview } from "@/lib/api/tax-shipping";
import { formatMinor } from "@/lib/api/money";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

function dollarsToMinor(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

export function TaxPreviewPanel({
  siteId,
  currency,
}: {
  siteId: number;
  currency: string;
}) {
  const [amount, setAmount] = useState("");
  const [country, setCountry] = useState("US");
  const [province, setProvince] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [result, setResult] = useState<TaxPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Preview tax</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Checkout recalculates from the cart. This is only a configuration preview.
          </p>
        </div>
        {result ? (
          <Badge variant={result.state === "calculated" ? "success" : "warning"}>
            {result.state.replace(/_/g, " ")}
          </Badge>
        ) : (
          <Badge variant="info">Preview only</Badge>
        )}
      </div>

      <form
        className="mt-5 grid gap-4 lg:grid-cols-[12rem_8rem_8rem_8rem_auto]"
        onSubmit={async (event) => {
          event.preventDefault();
          const amountMinor = dollarsToMinor(amount);
          if (amountMinor === null) {
            setError("Enter a valid amount.");
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
          <Label htmlFor="tax-preview-amount">Amount ({currency})</Label>
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
                {formatMinor(result.amountMinor, currency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Taxable base</dt>
              <dd className="tabular-nums text-foreground">
                {formatMinor(result.taxableBaseMinor, currency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Total</dt>
              <dd className="tabular-nums text-foreground">
                {formatMinor(result.totalMinor, currency)}
              </dd>
            </div>
          </dl>

          {result.note ? <p className="mt-3 text-sm text-muted">{result.note}</p> : null}
          {result.reason ? <p className="mt-2 text-sm text-muted">{result.reason}</p> : null}

          {result.breakdown.length > 0 ? (
            <ul className="mt-4 space-y-2 text-sm">
              {result.breakdown.map((item, index) => (
                <li key={`${item.name ?? "tax"}-${index}`} className="flex justify-between gap-4">
                  <span className="text-muted">
                    {(item.name ?? "Tax") + ` (${(item.rateBps / 100).toFixed(2)}%)`}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {formatMinor(item.amountMinor, currency)}
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
