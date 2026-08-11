"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { InventoryLevelRow } from "@/lib/api/commerce";
import { FetchError } from "@/components/dashboard/fetch-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/field";

export function StockLevelsPanel({
  items,
  lowStock,
  error,
}: {
  items: InventoryLevelRow[] | null;
  lowStock: number;
  error?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateLowStock(nextValue: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!next.get("tab")) next.set("tab", "products");
    next.set("lowStock", nextValue);
    next.delete("page");
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <section className="mt-8 rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-foreground">Stock levels</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Variants at or below the chosen available-stock threshold. Defaults to 5.
          </p>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const value = String(form.get("lowStock") ?? "").trim();
            updateLowStock(value || "5");
          }}
        >
          <div className="w-28">
            <Label htmlFor="stock-level-limit">Low stock ≤</Label>
            <Input
              id="stock-level-limit"
              name="lowStock"
              inputMode="numeric"
              min={0}
              defaultValue={String(lowStock)}
            />
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      </div>

      {error ? (
        <div className="mt-4">
          <FetchError title="Stock levels unavailable" message={error} />
        </div>
      ) : items && items.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Variant</th>
                <th className="px-4 py-3 font-medium">Available</th>
                <th className="px-4 py-3 font-medium">Policy</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.variantId} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{item.productName}</div>
                    {item.sku ? <div className="text-xs text-muted">{item.sku}</div> : null}
                  </td>
                  <td className="px-4 py-3 text-muted">{item.title}</td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{item.totalAvailable}</td>
                  <td className="px-4 py-3 text-muted">
                    {item.inventoryPolicy === "continue" ? "Continue selling" : "Stop at zero"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          className="mt-4"
          title="No low-stock variants"
          description="Nothing is at or below the current threshold."
        />
      )}
    </section>
  );
}
