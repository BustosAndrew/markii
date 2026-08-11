"use client";

import { useState } from "react";
import { previewDiscounts, type DiscountPreview } from "@/lib/api/commerce";
import { formatMinor } from "@/lib/api/money";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

type SiteOption = { id: number; name: string };

function dollarsToMinor(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

export function DiscountPreviewPanel({
  sites,
  selectedSiteId,
  currency,
}: {
  sites: SiteOption[];
  selectedSiteId: number | null;
  currency: string;
}) {
  const [siteId, setSiteId] = useState<number | null>(selectedSiteId ?? sites[0]?.id ?? null);
  const [codes, setCodes] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [result, setResult] = useState<DiscountPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Preview discounts</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            This preview redeems nothing and does not consume a single-use code.
          </p>
        </div>
        <Badge variant="info">No order is created</Badge>
      </div>

      <form
        className="mt-5 grid gap-4 lg:grid-cols-[12rem_1fr_12rem_auto]"
        onSubmit={async (event) => {
          event.preventDefault();
          const subtotalMinor = dollarsToMinor(subtotal);
          const parsedCodes = codes
            .split(/[,\n]/)
            .map((code) => code.trim())
            .filter(Boolean);
          if (siteId == null || subtotalMinor === null) {
            setError("Choose a store and enter a valid subtotal.");
            return;
          }
          if (parsedCodes.length === 0) {
            setError("Enter at least one discount code.");
            return;
          }
          setBusy(true);
          setError(null);
          try {
            setResult(
              await previewDiscounts({
                siteId,
                codes: parsedCodes,
                subtotalMinor,
              }),
            );
          } catch (previewError) {
            setError(publicErrorMessage(previewError, "Preview failed."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <Label htmlFor="discount-preview-site">Store</Label>
          <Select
            id="discount-preview-site"
            value={siteId ?? ""}
            disabled={busy || sites.length === 0}
            onChange={(event) => setSiteId(event.target.value ? Number(event.target.value) : null)}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="discount-preview-codes">Codes</Label>
          <Input
            id="discount-preview-codes"
            value={codes}
            disabled={busy}
            placeholder="SUMMER25, VIP"
            onChange={(event) => setCodes(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="discount-preview-subtotal">Subtotal ({currency})</Label>
          <Input
            id="discount-preview-subtotal"
            value={subtotal}
            inputMode="decimal"
            disabled={busy}
            placeholder="49.99"
            onChange={(event) => setSubtotal(event.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={busy || sites.length === 0}>
            {busy ? "Previewing…" : "Run preview"}
          </Button>
        </div>
      </form>

      {error ? <FieldError>{error}</FieldError> : null}

      {result ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-[var(--radius-control)] border border-border p-4">
            <h3 className="text-sm font-medium text-foreground">Applied</h3>
            {result.applied.length === 0 ? (
              <EmptyState
                className="mt-3 px-4 py-6"
                title="No codes applied"
                description="Every code was rejected for this subtotal and store."
              />
            ) : (
              <ul className="mt-3 space-y-3">
                {result.applied.map((discount) => (
                  <li key={`${discount.discountId}-${discount.code ?? discount.title}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <p className="font-medium text-foreground">{discount.title}</p>
                        <p className="text-xs text-muted">
                          {discount.code ?? "Automatic"} · {discount.type}
                        </p>
                      </div>
                      <p className="tabular-nums text-foreground">
                        {discount.freeShipping
                          ? "Free shipping"
                          : formatMinor(discount.amountMinor, currency)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-[var(--radius-control)] border border-border p-4">
            <h3 className="text-sm font-medium text-foreground">Rejected</h3>
            {result.rejected.length === 0 ? (
              <p className="mt-3 text-sm text-muted">Every entered code was eligible.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {result.rejected.map((rejection) => (
                  <li key={`${rejection.code}-${rejection.reason}`}>
                    <p className="font-medium text-foreground">{rejection.code}</p>
                    <p className="text-sm text-muted">{rejection.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-[var(--radius-control)] border border-border p-4 lg:col-span-2">
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">Subtotal</dt>
                <dd className="tabular-nums text-foreground">
                  {formatMinor(result.subtotalMinor, currency)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Discount total</dt>
                <dd className="tabular-nums text-foreground">
                  {formatMinor(result.totalDiscountMinor, currency)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">After discount</dt>
                <dd className="tabular-nums text-foreground">
                  {formatMinor(result.subtotalAfterDiscountMinor, currency)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      ) : null}
    </section>
  );
}
