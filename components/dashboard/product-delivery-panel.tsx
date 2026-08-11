"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  attachAsset,
  detachAsset,
  setDownloadPolicy,
  type DigitalAsset,
} from "@/lib/api/delivery";
import { publicErrorMessage } from "@/lib/api/public-copy";
import type { Product } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index]!;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export function ProductDeliveryPanel({
  product,
  library,
}: {
  product: Product;
  /** Org/site assets from the server — avoids a client fetch on mount. */
  library: DigitalAsset[];
}) {
  const router = useRouter();
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [limitMode, setLimitMode] = useState<"unlimited" | "limited">(
    product.downloadLimit == null ? "unlimited" : "limited",
  );
  const [expiryMode, setExpiryMode] = useState<"unlimited" | "limited">(
    product.downloadExpiryDays == null ? "unlimited" : "limited",
  );
  const [limitValue, setLimitValue] = useState(
    product.downloadLimit == null ? "3" : String(product.downloadLimit),
  );
  const [expiryValue, setExpiryValue] = useState(
    product.downloadExpiryDays == null ? "30" : String(product.downloadExpiryDays),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detachTarget, setDetachTarget] = useState<
    NonNullable<Product["digitalAssets"]>[number] | null
  >(null);

  const attachedAssets = useMemo(
    () => product.digitalAssets ?? [],
    [product.digitalAssets],
  );
  const attachedAssetIds = useMemo(
    () => new Set(attachedAssets.map((asset) => asset.assetId)),
    [attachedAssets],
  );
  const availableAssets = useMemo(
    () => library.filter((asset) => !attachedAssetIds.has(asset.id)),
    [library, attachedAssetIds],
  );

  async function refreshWithNotice(message: string) {
    setNotice(message);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Download policy</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Unlimited means the field is intentionally null on the product, not missing.
            </p>
          </div>
          <Badge variant="info">Files stay private</Badge>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="download-limit-mode">Download limit</Label>
            <Select
              id="download-limit-mode"
              value={limitMode}
              disabled={busy}
              onChange={(event) =>
                setLimitMode(event.target.value as "unlimited" | "limited")
              }
            >
              <option value="unlimited">Unlimited downloads</option>
              <option value="limited">Set a download limit</option>
            </Select>
            {limitMode === "limited" ? (
              <Input
                className="mt-2"
                inputMode="numeric"
                min={1}
                value={limitValue}
                disabled={busy}
                onChange={(event) => setLimitValue(event.target.value)}
              />
            ) : (
              <p className="mt-2 text-sm text-muted">
                Buyers can download this file any number of times.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="download-expiry-mode">Expiry</Label>
            <Select
              id="download-expiry-mode"
              value={expiryMode}
              disabled={busy}
              onChange={(event) =>
                setExpiryMode(event.target.value as "unlimited" | "limited")
              }
            >
              <option value="unlimited">Never expires</option>
              <option value="limited">Expire after a number of days</option>
            </Select>
            {expiryMode === "limited" ? (
              <Input
                className="mt-2"
                inputMode="numeric"
                min={1}
                value={expiryValue}
                disabled={busy}
                onChange={(event) => setExpiryValue(event.target.value)}
              />
            ) : (
              <p className="mt-2 text-sm text-muted">
                Downloads stay redeemable until you revoke them.
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button
            disabled={busy}
            onClick={() =>
              void (async () => {
                const downloadLimit =
                  limitMode === "unlimited" ? null : Number(limitValue.trim());
                const downloadExpiryDays =
                  expiryMode === "unlimited" ? null : Number(expiryValue.trim());
                if (
                  limitMode === "limited" &&
                  (!Number.isInteger(downloadLimit) || (downloadLimit ?? 0) <= 0)
                ) {
                  setError("Download limit must be a whole number.");
                  return;
                }
                if (
                  expiryMode === "limited" &&
                  (!Number.isInteger(downloadExpiryDays) || (downloadExpiryDays ?? 0) <= 0)
                ) {
                  setError("Expiry must be a whole number of days.");
                  return;
                }
                setBusy(true);
                setError(null);
                setNotice(null);
                try {
                  await setDownloadPolicy({
                    productId: product.id,
                    downloadLimit,
                    downloadExpiryDays,
                  });
                  await refreshWithNotice("Download policy saved.");
                } catch (policyError) {
                  setError(publicErrorMessage(policyError, "Policy update failed."));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {busy ? "Saving…" : "Save delivery policy"}
          </Button>
          <Link
            href="/dashboard/delivery"
            className="text-sm font-medium text-brand hover:text-brand-hover"
          >
            Manage uploaded files
          </Link>
        </div>
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Attached files</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Detach removes this product’s link to the file. It does not delete the asset from
              your library or other products.
            </p>
          </div>
          <Badge variant="neutral">
            {attachedAssets.length === 1
              ? "1 attachment"
              : `${attachedAssets.length} attachments`}
          </Badge>
        </div>

        {attachedAssets.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No files attached"
            description="Attach a file from your delivery library so paid buyers receive something to download."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">File</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Size</th>
                  <th className="px-4 py-3 font-medium">Applies to</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {attachedAssets.map((asset) => (
                  <tr key={asset.attachmentId} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">
                        {asset.label?.trim() || asset.fileName}
                      </div>
                      {asset.label?.trim() ? (
                        <div className="text-xs text-muted">{asset.fileName}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted">{asset.contentType}</td>
                    <td className="px-4 py-3 tabular-nums text-foreground">
                      {formatBytes(asset.sizeBytes)}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {asset.variantId == null ? "All variants" : `Variant #${asset.variantId}`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setDetachTarget(asset)}
                      >
                        Detach
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Attach from library</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Library files are filtered to this product’s storefront (plus org-level uploads).
        </p>

        {availableAssets.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No unattached files available"
            description="Upload a new file on the Delivery page, or detach one from another product if it should move here."
          />
        ) : (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Label htmlFor="attach-asset">Library file</Label>
              <Select
                id="attach-asset"
                value={selectedAssetId}
                disabled={busy}
                onChange={(event) => setSelectedAssetId(event.target.value)}
              >
                <option value="">Choose a file</option>
                {availableAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {(asset.label?.trim() || asset.fileName) +
                      " · " +
                      formatBytes(asset.sizeBytes)}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              disabled={busy || !selectedAssetId}
              onClick={() =>
                void (async () => {
                  if (!selectedAssetId) return;
                  setBusy(true);
                  setError(null);
                  setNotice(null);
                  try {
                    await attachAsset({
                      productId: product.id,
                      assetId: Number(selectedAssetId),
                    });
                    setSelectedAssetId("");
                    await refreshWithNotice("File attached.");
                  } catch (attachError) {
                    setError(publicErrorMessage(attachError, "Attach failed."));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {busy ? "Working…" : "Attach file"}
            </Button>
          </div>
        )}

        {notice ? <p className="mt-4 text-sm text-success-text">{notice}</p> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </section>

      <ConfirmDialog
        open={detachTarget !== null}
        title="Detach this file from the product?"
        description="This only removes the product attachment. The uploaded file stays in your delivery library and any other products that use it keep their copy."
        confirmLabel="Detach file"
        busy={busy}
        onClose={() => setDetachTarget(null)}
        onConfirm={async () => {
          if (!detachTarget) return;
          setBusy(true);
          setError(null);
          setNotice(null);
          try {
            await detachAsset({ attachmentId: detachTarget.attachmentId });
            setDetachTarget(null);
            await refreshWithNotice("File detached.");
          } catch (detachError) {
            setError(publicErrorMessage(detachError, "Detach failed."));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
