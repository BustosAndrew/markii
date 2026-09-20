"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  updateBillingAddress,
  type BillingAddress,
  type PlatformTax,
} from "@/lib/api/billing";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

/**
 * Where Markii invoices this org (G3). Without an address, Stripe Tax cannot
 * place the customer and every subscription is created untaxed — which the
 * API reports rather than hides.
 */
export function BillingAddressForm({
  address,
  tax,
}: {
  address: BillingAddress | null;
  tax: PlatformTax;
}) {
  const router = useRouter();
  const [line1, setLine1] = useState(address?.line1 ?? "");
  const [line2, setLine2] = useState(address?.line2 ?? "");
  const [city, setCity] = useState(address?.city ?? "");
  const [state, setState] = useState(address?.state ?? "");
  const [postalCode, setPostalCode] = useState(address?.postalCode ?? "");
  const [country, setCountry] = useState(address?.country ?? "US");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const countryCode = country.trim().toUpperCase();
  const needsState = countryCode === "US" || countryCode === "CA";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const outcome = await updateBillingAddress({
        line1,
        line2: line2.trim() === "" ? null : line2,
        city: city.trim() === "" ? null : city,
        state: state.trim() === "" ? null : state,
        postalCode,
        country: countryCode,
      });
      if (!outcome.ok || !outcome.result) {
        setError("The address could not be saved.");
        return;
      }
      setSaved(outcome.result.note || "Address saved.");
      router.refresh();
    } catch (err) {
      setError(publicErrorMessage(err, "The address could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Billing address</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Where Markii sends invoices. Sales tax on your plan is calculated from
        this address.
      </p>

      <p
        className={`mt-3 rounded-[var(--radius-control)] px-3 py-2 text-sm leading-6 ${
          tax.reason === "no_billing_address"
            ? "bg-warning-bg text-warning-text"
            : "bg-surface-elevated text-muted"
        }`}
      >
        {tax.message}
      </p>

      <form className="mt-4 grid max-w-xl gap-4" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <Label htmlFor="billing-line1">Address</Label>
          <Input
            id="billing-line1"
            autoComplete="address-line1"
            required
            value={line1}
            disabled={busy}
            onChange={(e) => setLine1(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="billing-line2">Apartment, suite (optional)</Label>
          <Input
            id="billing-line2"
            autoComplete="address-line2"
            value={line2}
            disabled={busy}
            onChange={(e) => setLine2(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="billing-city">City</Label>
            <Input
              id="billing-city"
              autoComplete="address-level2"
              value={city}
              disabled={busy}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="billing-state">
              {needsState ? "State / province" : "State / province (optional)"}
            </Label>
            <Input
              id="billing-state"
              autoComplete="address-level1"
              required={needsState}
              value={state}
              disabled={busy}
              onChange={(e) => setState(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="billing-postal">Postal code</Label>
            <Input
              id="billing-postal"
              autoComplete="postal-code"
              required
              value={postalCode}
              disabled={busy}
              onChange={(e) => setPostalCode(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="billing-country">Country (ISO, two letters)</Label>
            <Input
              id="billing-country"
              autoComplete="country"
              maxLength={2}
              required
              value={country}
              disabled={busy}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </div>
        </div>
        <FieldError>{error}</FieldError>
        {saved ? <p className="text-sm text-success-text">{saved}</p> : null}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : address ? "Update address" : "Save address"}
          </Button>
        </div>
      </form>
    </section>
  );
}
