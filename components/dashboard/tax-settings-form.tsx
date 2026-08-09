"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  updateTaxSettings,
  type ManualTaxRate,
  type TaxSettings,
} from "@/lib/api/tax-shipping";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

type SiteOption = { id: number; name: string };

type RateDraft = {
  country: string;
  province: string;
  percent: string;
  name: string;
};

function ratesToDrafts(rates: ManualTaxRate[]): RateDraft[] {
  if (rates.length === 0) {
    return [{ country: "", province: "", percent: "", name: "" }];
  }
  return rates.map((r) => ({
    country: r.country,
    province: r.province ?? "",
    percent: String(r.rateBps / 100),
    name: r.name ?? "",
  }));
}

function draftsToRates(drafts: RateDraft[]): ManualTaxRate[] {
  return drafts
    .filter((d) => d.country.trim())
    .map((d) => {
      const percent = Number(d.percent);
      if (!Number.isFinite(percent) || percent < 0) {
        throw new ApiClientError(400, "VALIDATION_ERROR", "Each rate needs a valid percentage.");
      }
      return {
        country: d.country.trim().toUpperCase(),
        province: d.province.trim() || null,
        rateBps: Math.round(percent * 100),
        name: d.name.trim() || null,
      };
    });
}

export function TaxSettingsForm({
  sites,
  siteId,
  settings,
}: {
  sites: SiteOption[];
  siteId: number;
  settings: TaxSettings;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [provider, setProvider] = useState<TaxSettings["provider"]>(
    settings.provider === "stripe" ? "manual" : settings.provider,
  );
  const [pricesIncludeTax, setPricesIncludeTax] = useState(settings.pricesIncludeTax);
  const [rateDrafts, setRateDrafts] = useState<RateDraft[]>(() =>
    ratesToDrafts(settings.manualRates),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function updateRate(index: number, patch: Partial<RateDraft>) {
    setRateDrafts((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const manualRates = provider === "manual" ? draftsToRates(rateDrafts) : [];
      await updateTaxSettings({
        siteId,
        provider,
        pricesIncludeTax,
        manualRates,
      });
      setNotice("Tax settings saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const operationalOk = settings.operational.ok;

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Store</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Tax settings apply per storefront.
            </p>
          </div>
          {sites.length > 1 ? (
            <div className="w-full max-w-xs sm:w-56">
              <Label htmlFor="tax-site">Storefront</Label>
              <Select
                id="tax-site"
                className="mt-1.5"
                value={siteId}
                disabled={busy}
                onChange={(e) => router.push(`${pathname}?siteId=${e.target.value}`)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Operational status</h2>
            <p className="mt-1 text-sm leading-6 text-muted">{settings.disclaimer}</p>
          </div>
          <Badge variant={operationalOk ? "success" : "warning"}>
            {operationalOk ? "Ready" : "Not ready"}
          </Badge>
        </div>
        {!operationalOk ? (
          <p className="mt-4 rounded-[var(--radius-control)] bg-warning-bg px-3 py-2 text-sm leading-6 text-warning-text">
            {settings.operational.reason}
          </p>
        ) : (
          <p className="mt-4 text-sm text-muted">
            Checkout can calculate tax with the current configuration.
          </p>
        )}
      </section>

      <form
        onSubmit={onSave}
        className="space-y-6 rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]"
      >
        <div>
          <h2 className="text-base font-medium text-foreground">Configuration</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Choose how tax is calculated at checkout. Markii does not file or remit on your behalf.
          </p>
        </div>

        <div className="max-w-md">
          <Label htmlFor="tax-provider">Provider</Label>
          <Select
            id="tax-provider"
            className="mt-1.5"
            value={provider}
            disabled={busy}
            onChange={(e) => setProvider(e.target.value as TaxSettings["provider"])}
          >
            <option value="none">None — do not calculate tax</option>
            <option value="manual">Manual rates</option>
            <option value="stripe" disabled>
              Stripe Tax (not available yet)
            </option>
          </Select>
          <p className="mt-1.5 text-xs text-muted">
            Stripe Tax is not available yet on Markii. Use manual rates or none until it ships.
          </p>
        </div>

        <Toggle
          checked={pricesIncludeTax}
          disabled={busy}
          onChange={setPricesIncludeTax}
          label="Prices include tax"
          description="When on, listed prices are tax-inclusive and checkout backs out the tax portion."
        />

        {provider === "manual" ? (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-foreground">Manual rates</h3>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || rateDrafts.length >= 20}
                onClick={() =>
                  setRateDrafts((prev) => [
                    ...prev,
                    { country: "", province: "", percent: "", name: "" },
                  ])
                }
              >
                Add rate
              </Button>
            </div>
            <div className="mt-3 space-y-3">
              {rateDrafts.map((row, index) => (
                <div
                  key={index}
                  className="grid gap-3 rounded-[var(--radius-control)] border border-border p-4 sm:grid-cols-2 lg:grid-cols-4"
                >
                  <div>
                    <Label htmlFor={`rate-country-${index}`}>Country</Label>
                    <Input
                      id={`rate-country-${index}`}
                      value={row.country}
                      placeholder="US"
                      disabled={busy}
                      onChange={(e) => updateRate(index, { country: e.target.value })}
                      className="mt-1.5 uppercase"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`rate-province-${index}`}>Province / state</Label>
                    <Input
                      id={`rate-province-${index}`}
                      value={row.province}
                      placeholder="CA"
                      disabled={busy}
                      onChange={(e) => updateRate(index, { province: e.target.value })}
                      className="mt-1.5 uppercase"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`rate-percent-${index}`}>Rate (%)</Label>
                    <Input
                      id={`rate-percent-${index}`}
                      value={row.percent}
                      inputMode="decimal"
                      placeholder="8.25"
                      disabled={busy}
                      onChange={(e) => updateRate(index, { percent: e.target.value })}
                      className="mt-1.5 tabular-nums"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`rate-name-${index}`}>Label (optional)</Label>
                    <Input
                      id={`rate-name-${index}`}
                      value={row.name}
                      placeholder="Sales tax"
                      disabled={busy}
                      onChange={(e) => updateRate(index, { name: e.target.value })}
                      className="mt-1.5"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save tax settings"}
          </Button>
          {notice ? <p className="text-sm text-success-text">{notice}</p> : null}
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      </form>
    </div>
  );
}
