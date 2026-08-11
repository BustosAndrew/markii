"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  deleteAsset,
  type DigitalAsset,
  type DigitalAssetList,
  uploadDigitalAsset,
} from "@/lib/api/delivery";
import { isConfigurationRequired } from "@/lib/api/planned";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError, Input, Label } from "@/components/ui/field";

type SiteOption = { id: number; name: string };

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

function UsageCard({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-sm)]">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
        {formatBytes(used)}
      </p>
      <p className="mt-1 text-sm text-muted">
        {limit == null ? "Advisory only" : `of ${formatBytes(limit)}`}
      </p>
    </div>
  );
}

export function DigitalAssetsPanel({
  initial,
  sites,
  selectedSiteId,
}: {
  initial: DigitalAssetList;
  sites: SiteOption[];
  selectedSiteId: number | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial.items);
  const [usage, setUsage] = useState(initial.usage);
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DigitalAsset | null>(null);
  const [configurationRequired, setConfigurationRequired] = useState(false);

  const siteNameById = useMemo(() => new Map(sites.map((site) => [site.id, site.name])), [sites]);

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Upload files</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Files stay private and are delivered from per-purchase download grants. This screen
              never shows a durable URL.
            </p>
          </div>
          <Badge variant="info">
            {selectedSiteId == null ? "Org-level scope" : "Filtered to one storefront"}
          </Badge>
        </div>

        <form
          className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!file) {
              setError("Choose a file to upload.");
              return;
            }
            setBusy(true);
            setError(null);
            setNotice(null);
            setConfigurationRequired(false);
            try {
              const uploaded = await uploadDigitalAsset(file, {
                siteId: selectedSiteId ?? undefined,
                label: label.trim() || undefined,
              });
              setItems((prev) => [...prev, uploaded]);
              setUsage(uploaded.usage);
              setLabel("");
              setFile(null);
              setNotice(`${uploaded.fileName} uploaded.`);
              router.refresh();
            } catch (uploadError) {
              setConfigurationRequired(isConfigurationRequired(uploadError));
              setError(publicErrorMessage(uploadError, "Upload failed."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="min-w-0 flex-1">
            <Label htmlFor="digital-asset-file">File</Label>
            <Input
              id="digital-asset-file"
              type="file"
              disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Label htmlFor="digital-asset-label">Label (optional)</Label>
            <Input
              id="digital-asset-label"
              value={label}
              disabled={busy}
              placeholder="Workbook, ZIP, source files…"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !file}>
            {busy ? "Uploading…" : "Upload asset"}
          </Button>
        </form>

        <p className="mt-3 text-xs leading-5 text-muted">
          Uploads use the current site filter. With no site selected, the asset is stored at the
          organization level and can be attached across storefronts.
        </p>
        {configurationRequired ? (
          <p className="mt-3 rounded-[var(--radius-control)] bg-warning-bg px-3 py-2 text-sm text-warning-text">
            This deployment needs additional platform configuration before files can be stored.
          </p>
        ) : null}
        {notice ? <p className="mt-3 text-sm text-success-text">{notice}</p> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <UsageCard
          label="Storage"
          used={usage.storageBytes}
          limit={usage.quota?.storageBytes ?? null}
        />
        <UsageCard
          label="Delivery this month"
          used={usage.deliveryBytes}
          limit={usage.quota?.deliveryBytes ?? null}
        />
      </section>
      <p className="text-xs text-muted">
        Usage is advisory only
        {usage.advisoryOnly ? " — nothing is blocked on these figures yet" : ""}. Delivery counts
        bytes authorised for download in the current calendar month, not bytes proved delivered.
      </p>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Uploaded assets</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Storage and egress are advisory usage figures. Nothing here reveals a file URL.
            </p>
          </div>
          <Badge variant="neutral">
            {items.length === 1 ? "1 asset" : `${items.length} assets`}
          </Badge>
        </div>

        {items.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No digital assets yet"
            description="Upload the files you sell here, then attach them to products from the product editor."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">File</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Size</th>
                  <th className="px-4 py-3 font-medium">Scope</th>
                  <th className="px-4 py-3 font-medium">Uploaded</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {items.map((asset) => (
                  <tr key={asset.id} className="border-b border-border last:border-0">
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
                      {asset.siteId == null
                        ? "All storefronts"
                        : (siteNameById.get(asset.siteId) ?? `Store #${asset.siteId}`)}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {new Date(asset.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        className="text-error-text"
                        disabled={busy}
                        onClick={() => {
                          setDeleteTarget(asset);
                          setError(null);
                          setNotice(null);
                        }}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this file?"
        description="Past buyers lose access immediately because their download grants point at this asset. Detaching a product keeps the file; deleting removes it."
        confirmLabel="Delete file"
        danger
        busy={busy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          setError(null);
          setNotice(null);
          try {
            await deleteAsset({ assetId: deleteTarget.id });
            setItems((prev) => prev.filter((asset) => asset.id !== deleteTarget.id));
            setNotice(`${deleteTarget.fileName} deleted.`);
            setDeleteTarget(null);
            router.refresh();
          } catch (deleteError) {
            setError(publicErrorMessage(deleteError, "Delete failed."));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
