"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  createShippingRate,
  createShippingZone,
  deleteShippingZone,
  type ShippingZone,
} from "@/lib/api/tax-shipping";
import { currencyExponent, formatMinor } from "@/lib/api/money";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

type SiteOption = { id: number; name: string };

function parseCountries(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

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
  const minor = Number(whole) * 10 ** exponent + Number(frac.padEnd(exponent, "0").slice(0, exponent));
  return Number.isFinite(minor) && minor >= 0 ? minor : null;
}

export function ShippingSettings({
  sites,
  siteId,
  currency,
  zones: initialZones,
}: {
  sites: SiteOption[];
  siteId: number;
  currency: string;
  zones: ShippingZone[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const zones = initialZones;
  const [zoneName, setZoneName] = useState("");
  const [zoneCountries, setZoneCountries] = useState("");
  const [rateNames, setRateNames] = useState<Record<number, string>>({});
  const [ratePrices, setRatePrices] = useState<Record<number, string>>({});
  const [removing, setRemoving] = useState<ShippingZone | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Store</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Shipping zones and rates apply per storefront.
            </p>
          </div>
          {sites.length > 1 ? (
            <div className="w-full max-w-xs sm:w-56">
              <Label htmlFor="shipping-site">Storefront</Label>
              <Select
                id="shipping-site"
                className="mt-1.5"
                value={siteId}
                disabled={busy !== null}
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
        <h2 className="text-base font-medium text-foreground">Create zone</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          A zone matches shopper addresses by country code. Add at least one flat rate so checkout
          can quote shipping.
        </p>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const name = zoneName.trim();
            const countries = parseCountries(zoneCountries);
            if (!name || countries.length === 0) {
              setError("Zone name and at least one country are required.");
              return;
            }
            void run("create-zone", async () => {
              await createShippingZone({ siteId, name, countries });
              setZoneName("");
              setZoneCountries("");
            });
          }}
        >
          <div>
            <Label htmlFor="zone-name">Zone name</Label>
            <Input
              id="zone-name"
              value={zoneName}
              placeholder="Domestic"
              disabled={busy !== null}
              onChange={(e) => setZoneName(e.target.value)}
              className="mt-1.5 w-48"
            />
          </div>
          <div>
            <Label htmlFor="zone-countries">Countries</Label>
            <Input
              id="zone-countries"
              value={zoneCountries}
              placeholder="US, CA"
              disabled={busy !== null}
              onChange={(e) => setZoneCountries(e.target.value)}
              className="mt-1.5 w-56"
            />
          </div>
          <Button type="submit" disabled={busy !== null}>
            {busy === "create-zone" ? "Creating…" : "Create zone"}
          </Button>
        </form>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Zones and rates</h2>

        {zones.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No shipping zones yet"
            description="Create a zone above, then add a flat rate so shoppers can choose shipping at checkout."
          />
        ) : (
          <div className="mt-4 space-y-4">
            {zones.map((zone) => {
              const rateCount = zone.rates?.length ?? zone.rateCount ?? 0;
              const hasWarning = rateCount === 0 || Boolean(zone.warning);
              return (
                <article
                  key={zone.id}
                  className="rounded-[var(--radius-control)] border border-border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium text-foreground">{zone.name}</h3>
                      <p className="mt-1 text-sm text-muted">
                        {zone.countries.join(", ") || "No countries"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {hasWarning ? (
                        <Badge variant="warning">
                          {zone.warning ?? "No rates — checkout will refuse this destination"}
                        </Badge>
                      ) : (
                        <Badge variant="success">
                          {rateCount} rate{rateCount === 1 ? "" : "s"}
                        </Badge>
                      )}
                      <Button
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => setRemoving(zone)}
                      >
                        Delete zone
                      </Button>
                    </div>
                  </div>

                  {zone.rates && zone.rates.length > 0 ? (
                    <ul className="mt-3 divide-y divide-border text-sm">
                      {zone.rates.map((rate) => (
                        <li key={rate.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <span className="text-foreground">{rate.name}</span>
                          <span className="text-muted">
                            Flat · {formatMinor(rate.priceMinor, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <form
                    className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = (rateNames[zone.id] ?? "").trim();
                      const priceMinor = parseDecimalToMinor(ratePrices[zone.id] ?? "", currency);
                      if (!name || priceMinor === null) {
                        setError("Rate name and a valid flat price are required.");
                        return;
                      }
                      void run(`rate-${zone.id}`, async () => {
                        await createShippingRate({
                          zoneId: zone.id,
                          name,
                          type: "flat",
                          priceMinor,
                        });
                        setRateNames((prev) => ({ ...prev, [zone.id]: "" }));
                        setRatePrices((prev) => ({ ...prev, [zone.id]: "" }));
                      });
                    }}
                  >
                    <div>
                      <Label htmlFor={`rate-name-${zone.id}`}>Flat rate name</Label>
                      <Input
                        id={`rate-name-${zone.id}`}
                        value={rateNames[zone.id] ?? ""}
                        placeholder="Standard"
                        disabled={busy !== null}
                        onChange={(e) =>
                          setRateNames((prev) => ({ ...prev, [zone.id]: e.target.value }))
                        }
                        className="mt-1.5 w-40"
                      />
                    </div>
                    <div>
                      <Label htmlFor={`rate-price-${zone.id}`}>Price ({currency})</Label>
                      <Input
                        id={`rate-price-${zone.id}`}
                        value={ratePrices[zone.id] ?? ""}
                        inputMode="decimal"
                        placeholder={currencyExponent(currency) === 0 ? "500" : "5.99"}
                        disabled={busy !== null}
                        onChange={(e) =>
                          setRatePrices((prev) => ({ ...prev, [zone.id]: e.target.value }))
                        }
                        className="mt-1.5 w-32 tabular-nums"
                      />
                    </div>
                    <Button type="submit" disabled={busy !== null}>
                      {busy === `rate-${zone.id}` ? "Adding…" : "Add flat rate"}
                    </Button>
                  </form>
                </article>
              );
            })}
          </div>
        )}

        {error ? <FieldError>{error}</FieldError> : null}
      </section>

      <ConfirmDialog
        open={removing !== null}
        danger
        busy={busy?.startsWith("delete-") ?? false}
        title={`Delete ${removing?.name ?? "zone"}?`}
        description={
          removing
            ? "This removes the zone and all of its shipping rates. Checkout will no longer offer those options."
            : ""
        }
        confirmLabel="Delete zone"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) {
            void run(`delete-${target.id}`, async () => {
              await deleteShippingZone({ zoneId: target.id });
            });
          }
        }}
      />
    </div>
  );
}
