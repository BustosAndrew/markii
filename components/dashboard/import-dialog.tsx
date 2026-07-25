"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  commitImport,
  importFromCsv,
  importFromUrl,
  type ImportedCategory,
  type ImportedItem,
  type ImportAllocation,
} from "@/lib/api/import";
import { ApiClientError, type Site } from "@/lib/api/types";
import { formatCents } from "@/lib/api/money";
import { assertCsvFile, assertPublicHttpsUrl } from "@/lib/validate-import";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

type Step = "source" | "allocate" | "done";

export function ImportDialog({
  open,
  onClose,
  sites,
  /** When set, skip allocate UI and return parsed items to parent (wizard draft). */
  onParsedDraft,
}: {
  open: boolean;
  onClose: () => void;
  sites: Site[];
  onParsedDraft?: (payload: {
    items: ImportedItem[];
    categories: ImportedCategory[];
    source: string;
  }) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("source");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [items, setItems] = useState<ImportedItem[]>([]);
  const [categories, setCategories] = useState<ImportedCategory[]>([]);
  const [failed, setFailed] = useState<{ row?: number; reason: string }[]>([]);
  const [siteByTempId, setSiteByTempId] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitFailed, setCommitFailed] = useState<
    { tempId: string; reason: string }[]
  >([]);
  const [createdCount, setCreatedCount] = useState(0);

  const defaultSiteId = String(sites[0]?.id ?? "");

  const allocationsReady = useMemo(() => {
    if (items.length === 0) return false;
    return items.every((item) => siteByTempId[item.tempId]);
  }, [items, siteByTempId]);

  function reset() {
    setStep("source");
    setUrl("");
    setSource("");
    setItems([]);
    setCategories([]);
    setFailed([]);
    setSiteByTempId({});
    setError(null);
    setBusy(false);
    setCommitFailed([]);
    setCreatedCount(0);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function runParse(kind: "url" | "csv", file?: File) {
    setBusy(true);
    setError(null);
    try {
      const result =
        kind === "url"
          ? await importFromUrl(assertPublicHttpsUrl(url))
          : await (async () => {
              if (!file) throw new ApiClientError(400, "VALIDATION_ERROR", "Choose a CSV file.");
              assertCsvFile(file);
              return importFromCsv(file);
            })();

      setSource(result.source);
      setItems(result.imported);
      setCategories(result.categories);
      setFailed(result.failed ?? []);

      if (onParsedDraft) {
        onParsedDraft({
          items: result.imported,
          categories: result.categories,
          source: result.source,
        });
        handleClose();
        return;
      }

      const initial: Record<string, string> = {};
      for (const item of result.imported) {
        initial[item.tempId] = defaultSiteId;
      }
      for (const cat of result.categories) {
        initial[cat.tempId] = defaultSiteId;
      }
      setSiteByTempId(initial);
      setStep("allocate");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    if (!allocationsReady) {
      setError("Assign every item to a site.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const catNameToTemp = new Map(
        categories.map((c) => [c.name.toLowerCase(), c.tempId]),
      );
      const allocations: ImportAllocation[] = [];

      for (const cat of categories) {
        const siteId = Number(siteByTempId[cat.tempId]);
        if (siteId) allocations.push({ tempId: cat.tempId, siteId });
      }

      for (const item of items) {
        const siteId = Number(siteByTempId[item.tempId]);
        const categoryTempId = item.categoryName
          ? catNameToTemp.get(item.categoryName.toLowerCase())
          : undefined;
        allocations.push({
          tempId: item.tempId,
          siteId,
          categoryTempId,
        });
      }

      const result = await commitImport({
        items,
        categories,
        allocations,
      });
      setCommitFailed(result.failed ?? []);
      setCreatedCount(result.createdProducts.length);
      setStep("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Commit failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-foreground/20"
        aria-label="Close import dialog"
        onClick={handleClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-md)]"
      >
        <div className="border-b border-border px-6 py-4">
          <h2 id="import-title" className="text-lg font-semibold text-foreground">
            Import catalog
          </h2>
          <p className="mt-1 text-sm text-muted">
            Upload a CSV or scrape a public Shopify / WooCommerce storefront URL.
          </p>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          {step === "source" ? (
            <div className="space-y-6">
              <div>
                <Label htmlFor="scrape-url">Storefront URL</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="scrape-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://your-store.myshopify.com"
                  />
                  <Button
                    type="button"
                    disabled={busy || !url.trim()}
                    onClick={() => runParse("url")}
                  >
                    Scrape URL
                  </Button>
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  Public https URLs only. Private / localhost hosts are blocked in
                  the UI.
                </p>
              </div>

              <div>
                <Label htmlFor="csv">CSV file</Label>
                <input
                  id="csv"
                  type="file"
                  accept=".csv,text/csv"
                  className="block w-full text-sm text-muted file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-hover file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-hover-soft"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void runParse("csv", file);
                  }}
                />
              </div>
            </div>
          ) : null}

          {step === "allocate" ? (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Source: <span className="text-foreground">{source || "import"}</span>
                {" · "}
                {items.length} products · {categories.length} categories
                {failed.length ? ` · ${failed.length} row errors` : ""}
              </p>

              {sites.length === 0 ? (
                <p className="text-sm text-error-text">
                  Create a website before committing an import.
                </p>
              ) : null}

              <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="bg-surface-elevated text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="px-3 py-2 font-medium">Price</th>
                      <th className="px-3 py-2 font-medium">Assign site</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.tempId} className="border-t border-border">
                        <td className="px-3 py-2">
                          <p className="font-medium text-foreground">{item.name}</p>
                          <p className="text-xs text-muted">
                            {item.categoryName || "Uncategorized"}
                          </p>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted">
                          {formatCents(item.priceCents, item.currency ?? "USD")}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={siteByTempId[item.tempId] ?? ""}
                            onChange={(e) =>
                              setSiteByTempId((prev) => ({
                                ...prev,
                                [item.tempId]: e.target.value,
                              }))
                            }
                          >
                            <option value="" disabled>
                              Select site
                            </option>
                            {sites.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {failed.length > 0 ? (
                <ul className="space-y-1 text-sm text-muted">
                  {failed.map((f, i) => (
                    <li key={`${f.row}-${i}`}>
                      Row {f.row ?? "?"}: {f.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {step === "done" ? (
            <div className="space-y-3 text-sm">
              <p className="text-foreground">
                Created {createdCount} product
                {createdCount === 1 ? "" : "s"}.
              </p>
              {commitFailed.length > 0 ? (
                <ul className="space-y-1 text-muted">
                  {commitFailed.map((f) => (
                    <li key={f.tempId}>
                      {f.tempId}: {f.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <FieldError>{error}</FieldError>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="secondary" onClick={handleClose} disabled={busy}>
            {step === "done" ? "Close" : "Cancel"}
          </Button>
          {step === "allocate" ? (
            <Button
              onClick={() => void runCommit()}
              disabled={busy || sites.length === 0 || !allocationsReady}
            >
              {busy ? "Committing…" : "Commit import"}
            </Button>
          ) : null}
          {step === "done" ? (
            <Button
              onClick={() => {
                handleClose();
                router.push("/dashboard/inventory");
              }}
            >
              View inventory
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
