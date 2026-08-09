"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createDiscount,
  deleteDiscount,
  updateDiscount,
  type Discount,
  type DiscountInput,
} from "@/lib/api/commerce";
import { currencyExponent, formatMinor } from "@/lib/api/money";
import { ApiClientError, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Select } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function parseMinorInput(value: string, currency: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10 ** currencyExponent(currency));
}

export function DiscountForm({
  mode,
  discount,
  sites,
  currency,
}: {
  mode: "create" | "edit";
  discount?: Discount;
  sites: Site[];
  currency: string;
}) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(
    String(discount?.siteId ?? sites[0]?.id ?? ""),
  );
  const [title, setTitle] = useState(discount?.title ?? "");
  const [code, setCode] = useState(discount?.code ?? "");
  const [type, setType] = useState<Discount["type"]>(discount?.type ?? "percentage");
  const [percent, setPercent] = useState(
    discount?.percentageBps != null ? String(discount.percentageBps / 100) : "",
  );
  const [fixedAmount, setFixedAmount] = useState(
    discount?.valueMinor != null
      ? String(discount.valueMinor / 10 ** currencyExponent(currency))
      : "",
  );
  const [enabled, setEnabled] = useState(discount?.enabled ?? true);
  const [startsAt, setStartsAt] = useState(toDateInput(discount?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toDateInput(discount?.endsAt ?? null));
  const [usageLimit, setUsageLimit] = useState(
    discount?.usageLimit != null ? String(discount.usageLimit) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  function buildBody(): ({ siteId: number } & DiscountInput) | null {
    if (!siteId || !title.trim()) {
      setError("Site and title are required.");
      return null;
    }

    const body: { siteId: number } & DiscountInput = {
      siteId: Number(siteId),
      title: title.trim(),
      type,
      appliesToScope: "order",
      enabled,
      code: code.trim() ? code.trim().toUpperCase() : null,
      startsAt: startsAt ? new Date(`${startsAt}T00:00:00`).toISOString() : null,
      endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : null,
      usageLimit: usageLimit.trim() ? Number(usageLimit) : null,
    };

    if (type === "percentage") {
      const pct = Number(percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        setError("Enter a percentage between 0 and 100.");
        return null;
      }
      body.percentageBps = Math.round(pct * 100);
      body.valueMinor = null;
    } else if (type === "fixed") {
      const valueMinor = parseMinorInput(fixedAmount, currency);
      if (valueMinor == null) {
        setError("Enter a valid fixed amount.");
        return null;
      }
      body.valueMinor = valueMinor;
      body.percentageBps = null;
    } else {
      body.percentageBps = null;
      body.valueMinor = null;
    }

    return body;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = buildBody();
    if (!body) return;

    setBusy(true);
    try {
      if (mode === "create") {
        const outcome = await createDiscount(body);
        if (!outcome.ok || !outcome.result) {
          setError("Discount could not be created.");
          return;
        }
        router.push(`/dashboard/discounts/${outcome.result.id}`);
        router.refresh();
      } else if (discount) {
        const { siteId: _, ...updates } = body;
        void _;
        const outcome = await updateDiscount({
          discountId: discount.id,
          ...updates,
        });
        if (!outcome.ok) {
          setError("Discount could not be saved.");
          return;
        }
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-5">
      {mode === "create" ? (
        <div>
          <Label htmlFor="site">Site</Label>
          <Select
            id="site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            required
          >
            <option value="" disabled>
              Select a site
            </option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <div>
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>

      <div>
        <Label htmlFor="code">Code</Label>
        <Input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Leave empty for automatic"
          className="font-mono uppercase"
        />
        <p className="mt-1 text-xs text-muted">
          Empty means automatic — applied without the shopper typing a code.
        </p>
      </div>

      <div>
        <Label htmlFor="type">Type</Label>
        <Select
          id="type"
          value={type}
          onChange={(e) => setType(e.target.value as Discount["type"])}
        >
          <option value="percentage">Percentage off</option>
          <option value="fixed">Fixed amount off</option>
          <option value="free_shipping">Free shipping</option>
        </Select>
      </div>

      {type === "percentage" ? (
        <div>
          <Label htmlFor="percent">Percentage</Label>
          <Input
            id="percent"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            placeholder="15"
            required
          />
        </div>
      ) : null}

      {type === "fixed" ? (
        <div>
          <Label htmlFor="fixed">Amount off</Label>
          <Input
            id="fixed"
            inputMode="decimal"
            value={fixedAmount}
            onChange={(e) => setFixedAmount(e.target.value)}
            placeholder={formatMinor(1000, currency).replace(/[^\d.,]/g, "")}
            required
          />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="starts">Starts (optional)</Label>
          <Input
            id="starts"
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ends">Ends (optional)</Label>
          <Input
            id="ends"
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="usage-limit">Usage limit (optional)</Label>
        <Input
          id="usage-limit"
          type="number"
          min={1}
          value={usageLimit}
          onChange={(e) => setUsageLimit(e.target.value)}
          placeholder="Unlimited"
        />
      </div>

      <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
        <Toggle
          label="Enabled"
          description="Disabled discounts never apply, regardless of dates."
          checked={enabled}
          onChange={setEnabled}
          disabled={busy}
        />
      </div>

      <FieldError>{error}</FieldError>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy
            ? "Saving…"
            : mode === "create"
              ? "Create discount"
              : "Save changes"}
        </Button>
        {mode === "edit" && discount ? (
          <Button
            type="button"
            variant="ghost"
            className="text-error-text"
            disabled={busy}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        ) : null}
      </div>

      {discount ? (
        <ConfirmDialog
          open={deleteOpen}
          title="Delete this discount?"
          description="Shoppers with this code in their cart will lose it. Redemption history is kept."
          confirmLabel="Delete"
          danger
          busy={busy}
          onClose={() => setDeleteOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              const outcome = await deleteDiscount({ discountId: discount.id });
              if (!outcome.ok) {
                setError("Discount could not be deleted.");
                setBusy(false);
                setDeleteOpen(false);
                return;
              }
              router.push("/dashboard/discounts");
              router.refresh();
            } catch (err) {
              setError(
                err instanceof ApiClientError ? err.message : "Delete failed.",
              );
              setBusy(false);
              setDeleteOpen(false);
            }
          }}
        />
      ) : null}
    </form>
  );
}
