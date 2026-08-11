"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { reissueDownload, revokeDownload } from "@/lib/api/delivery";
import { publicErrorMessage } from "@/lib/api/public-copy";
import type { OrderDownload } from "@/lib/api/orders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";

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

export function OrderDownloads({ downloads }: { downloads: OrderDownload[] }) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reissueTarget, setReissueTarget] = useState<OrderDownload | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OrderDownload | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { extendDays: string; reason: string }>>({});

  const valuesFor = (downloadId: number) =>
    drafts[downloadId] ?? {
      extendDays: "",
      reason: "",
    };

  const revokeReason = revokeTarget
    ? (drafts[revokeTarget.id]?.reason ?? "").trim()
    : "";

  return (
    <div className="space-y-3">
      {downloads.map((download) => {
        const draft = valuesFor(download.id);
        return (
          <div
            key={download.id}
            className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-sm)]"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-medium text-foreground">{download.fileName}</p>
                <p className="text-xs text-muted">{formatBytes(download.sizeBytes)}</p>
              </div>
              {download.redeemable ? (
                <Badge variant="success">Redeemable</Badge>
              ) : (
                <Badge variant="error">Revoked</Badge>
              )}
            </div>

            <p className="mt-2 text-sm text-muted">
              {download.downloadsUsed} of {download.downloadLimit ?? "unlimited"} downloads used
              {download.expiresAt ? ` · expires ${new Date(download.expiresAt).toLocaleDateString()}` : ""}
              {download.lastDownloadedAt
                ? ` · last ${new Date(download.lastDownloadedAt).toLocaleString()}`
                : " · never downloaded"}
            </p>
            {download.revokedReason ? (
              <p className="mt-1 text-sm text-muted">Revoked: {download.revokedReason}</p>
            ) : null}

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-[var(--radius-control)] border border-border p-3">
                <Label htmlFor={`reissue-extend-${download.id}`}>Extend by days (optional)</Label>
                <Input
                  id={`reissue-extend-${download.id}`}
                  inputMode="numeric"
                  min={1}
                  value={draft.extendDays}
                  disabled={busyKey !== null}
                  placeholder="30"
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [download.id]: {
                        ...valuesFor(download.id),
                        extendDays: event.target.value,
                      },
                    }))
                  }
                />
                {/*
                  A revoked grant needs `unrevoke`, and saying so is the point.
                  Resetting the count on a revoked grant changes nothing the
                  buyer can see — `revokedAt` is what the download gate checks
                  — so a plain "Reissue" here would report success while the
                  buyer stayed locked out.
                */}
                <p className="mt-2 text-xs leading-5 text-muted">
                  {download.redeemable
                    ? "Reissue resets the download count. It can also extend the expiry window without exposing a link or token here."
                    : "This download is revoked, so resetting the count alone would change nothing. Restoring lifts the revocation and resets the count."}
                </p>
                <Button
                  className="mt-3"
                  variant="secondary"
                  disabled={busyKey !== null}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setReissueTarget(download);
                  }}
                >
                  {download.redeemable ? "Reissue download" : "Restore access"}
                </Button>
              </div>

              <div className="rounded-[var(--radius-control)] border border-border p-3">
                <Label htmlFor={`revoke-reason-${download.id}`}>Revoke reason</Label>
                <Input
                  id={`revoke-reason-${download.id}`}
                  value={draft.reason}
                  disabled={busyKey !== null}
                  placeholder="Chargeback, fraud, or another support reason"
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [download.id]: {
                        ...valuesFor(download.id),
                        reason: event.target.value,
                      },
                    }))
                  }
                />
                <p className="mt-2 text-xs leading-5 text-muted">
                  Download links and tokens are never shown here. Support actions work from the
                  grant record only.
                </p>
                <Button
                  className="mt-3 text-error-text"
                  variant="ghost"
                  disabled={busyKey !== null || !draft.reason.trim()}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setRevokeTarget(download);
                  }}
                >
                  Revoke download
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      <p className="text-xs text-muted">
        Download links are not shown here. The grant token is the buyer&rsquo;s credential and
        support actions do not need it.
      </p>
      {notice ? <p className="text-sm text-success-text">{notice}</p> : null}
      {error ? <FieldError>{error}</FieldError> : null}

      <ConfirmDialog
        open={reissueTarget !== null}
        title={
          reissueTarget && !reissueTarget.redeemable
            ? "Restore access to this download?"
            : "Reissue this download?"
        }
        description={
          reissueTarget && !reissueTarget.redeemable
            ? "This lifts the revocation and resets the download count, so the buyer can download again. It does not reveal a token or a durable file URL."
            : "This resets the download count and can extend the expiry window. It does not reveal a token or a durable file URL."
        }
        confirmLabel={
          reissueTarget && !reissueTarget.redeemable ? "Restore access" : "Reissue download"
        }
        busy={busyKey?.startsWith("reissue-") ?? false}
        onClose={() => setReissueTarget(null)}
        onConfirm={async () => {
          if (!reissueTarget) return;
          const extendDaysRaw = valuesFor(reissueTarget.id).extendDays.trim();
          const parsedExtendDays = extendDaysRaw ? Number(extendDaysRaw) : null;
          if (
            extendDaysRaw &&
            (!Number.isInteger(parsedExtendDays) || (parsedExtendDays ?? 0) <= 0)
          ) {
            setError("Extend days must be a whole number.");
            return;
          }
          const key = `reissue-${reissueTarget.id}`;
          setBusyKey(key);
          setError(null);
          setNotice(null);
          try {
            const restoring = !reissueTarget.redeemable;
            await reissueDownload({
              grantId: reissueTarget.id,
              resetCount: true,
              extendDays: parsedExtendDays ?? undefined,
              /**
               * Only ever true for a grant that is actually revoked. Sending it
               * unconditionally would make a routine reissue silently reverse a
               * revocation the merchant meant to keep.
               */
              unrevoke: restoring,
            });
            setNotice(
              restoring
                ? `Restored access to ${reissueTarget.fileName}.`
                : `Reissued ${reissueTarget.fileName}.`,
            );
            setReissueTarget(null);
            router.refresh();
          } catch (reissueError) {
            setError(publicErrorMessage(reissueError, "Reissue failed."));
          } finally {
            setBusyKey(null);
          }
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this download?"
        description={
          revokeReason
            ? `This withdraws access. Reason: ${revokeReason}`
            : "This withdraws access from the buyer."
        }
        confirmLabel="Revoke download"
        danger
        busy={busyKey?.startsWith("revoke-") ?? false}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (!revokeTarget) return;
          const reason = valuesFor(revokeTarget.id).reason.trim();
          if (!reason) {
            setError("A revoke reason is required.");
            return;
          }
          const key = `revoke-${revokeTarget.id}`;
          setBusyKey(key);
          setError(null);
          setNotice(null);
          try {
            await revokeDownload({ grantId: revokeTarget.id, reason });
            setNotice(`Revoked ${revokeTarget.fileName}.`);
            setRevokeTarget(null);
            router.refresh();
          } catch (revokeError) {
            setError(publicErrorMessage(revokeError, "Revoke failed."));
          } finally {
            setBusyKey(null);
          }
        }}
      />
    </div>
  );
}
