"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  adjustInventory,
  getVariantMatrix,
  listLocations,
  setProductOptions,
  updateVariant,
  type Location,
  type ProductOption,
  type Variant,
  type VariantMatrix,
} from "@/lib/api/commerce";
import { currencyExponent, decimalMinor, formatMinor } from "@/lib/api/money";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";

type OptionDraft = { name: string; valuesText: string };

type VariantDraft = {
  priceInput: string;
  sku: string;
  inventoryPolicy: Variant["inventoryPolicy"];
  taxable: boolean;
  taxCode: string;
  adjustDelta: string;
  adjustLocationId: string;
};

function parseOptionValues(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function optionsToDrafts(options: ProductOption[]): OptionDraft[] {
  const drafts = options.map((o) => ({
    name: o.name,
    valuesText: o.values.join(", "),
  }));
  while (drafts.length < 3) drafts.push({ name: "", valuesText: "" });
  return drafts.slice(0, 3);
}

function parseDecimalToMinor(value: string, currency: string): number | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return null;
  const exponent = currencyExponent(currency);
  if (exponent === 0) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = unsigned.split(".");
  if (frac.length > exponent) return null;
  const minor =
    Number(whole) * 10 ** exponent + Number(frac.padEnd(exponent, "0").slice(0, exponent));
  if (!Number.isFinite(minor) || minor < 0) return null;
  return negative ? -minor : minor;
}

function variantDraftFromRow(v: Variant, currency: string): VariantDraft {
  return {
    priceInput: decimalMinor(v.priceMinor, currency),
    sku: v.sku ?? "",
    inventoryPolicy: v.inventoryPolicy,
    taxable: v.taxable,
    taxCode: v.taxCode ?? "",
    adjustDelta: "",
    adjustLocationId: "",
  };
}

function inventoryAvailable(v: Variant): number {
  return v.inventoryLevels.reduce((sum, level) => sum + level.available, 0);
}

export function VariantEditor({
  productId,
  siteId,
  currency,
  matrix: initialMatrix,
  taxProvider,
}: {
  productId: number;
  siteId: number;
  currency: string;
  matrix: VariantMatrix;
  /** Saved tax provider for this store — `taxable: false` is honoured on Stripe Tax only. */
  taxProvider?: "none" | "manual" | "stripe";
}) {
  const router = useRouter();
  const [matrix, setMatrix] = useState(initialMatrix);
  const [optionDrafts, setOptionDrafts] = useState<OptionDraft[]>(() =>
    optionsToDrafts(initialMatrix.options),
  );
  const [defaultPriceInput, setDefaultPriceInput] = useState("");
  const [variantDrafts, setVariantDrafts] = useState<Record<number, VariantDraft>>(() =>
    Object.fromEntries(
      initialMatrix.variants.map((v) => [v.id, variantDraftFromRow(v, currency)]),
    ),
  );
  const [locations, setLocations] = useState<Location[]>([]);
  const [orphanedNotice, setOrphanedNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listLocations({ siteId })
      .then((res) => {
        if (!cancelled) setLocations(res.items);
      })
      .catch(() => {
        if (!cancelled) setLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const totalInventory = useMemo(
    () => matrix.variants.reduce((sum, v) => sum + inventoryAvailable(v), 0),
    [matrix.variants],
  );

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

  async function refreshMatrix() {
    const next = await getVariantMatrix(productId, { siteId });
    setMatrix(next);
    setOptionDrafts(optionsToDrafts(next.options));
    setVariantDrafts(
      Object.fromEntries(next.variants.map((v) => [v.id, variantDraftFromRow(v, currency)])),
    );
  }

  function updateOptionDraft(index: number, patch: Partial<OptionDraft>) {
    setOptionDrafts((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function updateVariantDraft(variantId: number, patch: Partial<VariantDraft>) {
    setVariantDrafts((prev) => ({
      ...prev,
      [variantId]: { ...prev[variantId], ...patch },
    }));
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Option axes</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Up to three axes (for example Size and Color). Saving regenerates the variant matrix.
          Existing combinations keep their price, SKU, and stock; removed combinations are reported
          as orphaned and are not deleted automatically.
        </p>

        <div className="mt-4 space-y-4">
          {optionDrafts.map((row, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-[var(--radius-control)] border border-border p-4 sm:grid-cols-2"
            >
              <div>
                <Label htmlFor={`option-name-${index}`}>Option {index + 1} name</Label>
                <Input
                  id={`option-name-${index}`}
                  value={row.name}
                  placeholder={index === 0 ? "Size" : "Color"}
                  disabled={busy !== null}
                  onChange={(e) => updateOptionDraft(index, { name: e.target.value })}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor={`option-values-${index}`}>Values</Label>
                <Textarea
                  id={`option-values-${index}`}
                  value={row.valuesText}
                  placeholder="Small, Medium, Large"
                  rows={2}
                  disabled={busy !== null}
                  onChange={(e) => updateOptionDraft(index, { valuesText: e.target.value })}
                  className="mt-1.5"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 max-w-xs">
          <Label htmlFor="default-price">
            Default price for new variants ({currency})
          </Label>
          <Input
            id="default-price"
            value={defaultPriceInput}
            inputMode="decimal"
            placeholder={currencyExponent(currency) === 0 ? "1000" : "19.99"}
            disabled={busy !== null}
            onChange={(e) => setDefaultPriceInput(e.target.value)}
            className="mt-1.5"
          />
          <p className="mt-1 text-xs text-muted">
            Leave blank to use the product&apos;s base price for newly created combinations.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy !== null}
            onClick={() =>
              void run("options", async () => {
                const options: ProductOption[] = optionDrafts
                  .map((row, position) => ({
                    name: row.name.trim(),
                    position,
                    values: parseOptionValues(row.valuesText),
                  }))
                  .filter((o) => o.name && o.values.length > 0);

                const defaultPriceMinor =
                  defaultPriceInput.trim() === ""
                    ? undefined
                    : parseDecimalToMinor(defaultPriceInput, currency) ?? undefined;

                if (defaultPriceInput.trim() !== "" && defaultPriceMinor === undefined) {
                  throw new ApiClientError(400, "VALIDATION_ERROR", "Enter a valid default price.");
                }

                const outcome = await setProductOptions({
                  productId,
                  options,
                  defaultPriceMinor,
                });

                if (!outcome.ok || !outcome.result) {
                  throw new ApiClientError(400, "VALIDATION_ERROR", "Options could not be saved.");
                }

                const result = outcome.result;
                if (result.orphaned.length > 0) {
                  setOrphanedNotice(
                    `${result.orphaned.length} variant${
                      result.orphaned.length === 1 ? "" : "s"
                    } no longer match the option axes and remain in the catalog until you remove them manually.`,
                  );
                } else {
                  setOrphanedNotice(null);
                }

                await refreshMatrix();
              })
            }
          >
            {busy === "options" ? "Saving options…" : "Save options"}
          </Button>
          {orphanedNotice ? (
            <Badge variant="warning">{orphanedNotice}</Badge>
          ) : null}
        </div>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Variants</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Edit price, SKU, and inventory policy per combination. Prices use{" "}
              {currencyExponent(currency) === 0 ? "whole units" : "decimal amounts"} for{" "}
              {currency}.
            </p>
          </div>
          <p className="text-sm text-muted">
            Total on hand:{" "}
            <span className="font-medium tabular-nums text-foreground">{totalInventory}</span>
          </p>
        </div>

        {matrix.variants.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No variants yet"
            description="Add option axes above and save to generate combinations."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-medium">Variant</th>
                  <th className="py-2 pr-4 font-medium">Price ({currency})</th>
                  <th className="py-2 pr-4 font-medium">SKU</th>
                  <th className="py-2 pr-4 font-medium">Inventory</th>
                  <th className="py-2 pr-4 font-medium">Policy</th>
                  <th className="py-2 pr-4 font-medium">Taxable</th>
                  <th className="py-2 pr-4 font-medium">Tax code</th>
                  {locations.length > 0 ? (
                    <th className="py-2 pr-4 font-medium">Adjust stock</th>
                  ) : null}
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {matrix.variants.map((v) => {
                  const draft = variantDrafts[v.id] ?? variantDraftFromRow(v, currency);
                  const onHand = inventoryAvailable(v);
                  return (
                    <tr key={v.id} className="border-b border-border last:border-0 align-top">
                      <td className="py-3 pr-4">
                        <div className="font-medium text-foreground">{v.title}</div>
                        <div className="text-xs text-muted">
                          {Object.entries(v.optionValues)
                            .map(([k, val]) => `${k}: ${val}`)
                            .join(" · ") || "Default"}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <Input
                          value={draft.priceInput}
                          inputMode="decimal"
                          disabled={busy !== null}
                          onChange={(e) =>
                            updateVariantDraft(v.id, { priceInput: e.target.value })
                          }
                          className="w-28 tabular-nums"
                          aria-label={`Price for ${v.title}`}
                        />
                        <p className="mt-1 text-xs text-muted">{formatMinor(v.priceMinor, currency)}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <Input
                          value={draft.sku}
                          disabled={busy !== null}
                          onChange={(e) => updateVariantDraft(v.id, { sku: e.target.value })}
                          className="w-32"
                          aria-label={`SKU for ${v.title}`}
                        />
                      </td>
                      <td className="py-3 pr-4 tabular-nums text-foreground">{onHand}</td>
                      <td className="py-3 pr-4">
                        <Select
                          value={draft.inventoryPolicy}
                          disabled={busy !== null}
                          onChange={(e) =>
                            updateVariantDraft(v.id, {
                              inventoryPolicy: e.target.value as Variant["inventoryPolicy"],
                            })
                          }
                          className="w-36"
                          aria-label={`Inventory policy for ${v.title}`}
                        >
                          <option value="deny">Stop selling at 0</option>
                          <option value="continue">Allow overselling</option>
                        </Select>
                      </td>
                      <td className="py-3 pr-4">
                        <label className="flex items-center gap-2 text-sm text-foreground">
                          <input
                            type="checkbox"
                            checked={draft.taxable}
                            disabled={busy !== null}
                            onChange={(e) =>
                              updateVariantDraft(v.id, { taxable: e.target.checked })
                            }
                            className="size-4 rounded border-border accent-[var(--brand)]"
                            aria-label={`Taxable for ${v.title}`}
                          />
                          Taxable
                        </label>
                      </td>
                      <td className="py-3 pr-4">
                        <Input
                          value={draft.taxCode}
                          disabled={busy !== null}
                          placeholder="txcd_…"
                          onChange={(e) =>
                            updateVariantDraft(v.id, { taxCode: e.target.value })
                          }
                          className="w-36"
                          aria-label={`Tax code for ${v.title}`}
                        />
                      </td>
                      {locations.length > 0 ? (
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              value={draft.adjustLocationId}
                              disabled={busy !== null}
                              onChange={(e) =>
                                updateVariantDraft(v.id, { adjustLocationId: e.target.value })
                              }
                              className="w-36"
                              aria-label={`Location for ${v.title}`}
                            >
                              <option value="">Location</option>
                              {locations.map((loc) => (
                                <option key={loc.id} value={loc.id}>
                                  {loc.name}
                                </option>
                              ))}
                            </Select>
                            <Input
                              value={draft.adjustDelta}
                              inputMode="numeric"
                              placeholder="+/- qty"
                              disabled={busy !== null}
                              onChange={(e) =>
                                updateVariantDraft(v.id, { adjustDelta: e.target.value })
                              }
                              className="w-24 tabular-nums"
                              aria-label={`Stock adjustment for ${v.title}`}
                            />
                            <Button
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`adjust-${v.id}`, async () => {
                                  const delta = Number(draft.adjustDelta);
                                  if (
                                    !draft.adjustLocationId ||
                                    !Number.isFinite(delta) ||
                                    delta === 0
                                  ) {
                                    throw new ApiClientError(
                                      400,
                                      "VALIDATION_ERROR",
                                      "Pick a location and a non-zero adjustment.",
                                    );
                                  }
                                  await adjustInventory({
                                    variantId: v.id,
                                    locationId: draft.adjustLocationId,
                                    delta: Math.trunc(delta),
                                  });
                                  updateVariantDraft(v.id, { adjustDelta: "" });
                                  await refreshMatrix();
                                })
                              }
                            >
                              {busy === `adjust-${v.id}` ? "…" : "Apply"}
                            </Button>
                          </div>
                        </td>
                      ) : null}
                      <td className="py-3 text-right">
                        <Button
                          disabled={busy !== null}
                          onClick={() =>
                            void run(`variant-${v.id}`, async () => {
                              const priceMinor = parseDecimalToMinor(draft.priceInput, currency);
                              if (priceMinor === null) {
                                throw new ApiClientError(
                                  400,
                                  "VALIDATION_ERROR",
                                  `Enter a valid price for ${v.title}.`,
                                );
                              }
                              await updateVariant({
                                variantId: v.id,
                                priceMinor,
                                sku: draft.sku.trim() || null,
                                inventoryPolicy: draft.inventoryPolicy,
                                taxable: draft.taxable,
                                taxCode: draft.taxCode.trim() || null,
                              });
                              await refreshMatrix();
                            })
                          }
                        >
                          {busy === `variant-${v.id}` ? "Saving…" : "Save"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs leading-5 text-muted">
          {taxProvider === "manual"
            ? "Untaxed variants are ignored on a manual-rate store — one rate covers the whole basket. Switch the store to Stripe Tax in Settings → Tax to honour per-variant exemptions."
            : "Untaxed variants are honoured on Stripe Tax only. A manual rate has nowhere to express a per-line exemption."}
        </p>

        {error ? <FieldError>{error}</FieldError> : null}
      </section>
    </div>
  );
}
