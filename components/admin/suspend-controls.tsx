"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Label, Textarea } from "@/components/ui/field";
import { LocalDateTime } from "@/components/ui/local-date";
import { suspendPlatformOrg, unsuspendPlatformOrg, type PlatformOrgView } from "@/lib/api/admin";
import { ApiClientError } from "@/lib/api/types";

/**
 * Suspend / reinstate an org (G12). Both go through the registry, so the
 * step-up modal (`MfaStepUpProvider`) appears as it would for a refund, and
 * the merchant's audit log records the operator and the reason.
 *
 * The reason box says who reads it, because that is the thing an operator is
 * most likely to get wrong: it is not a private note.
 */
export function SuspendControls({ org }: { org: PlatformOrgView }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [confirmLift, setConfirmLift] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Request failed.");
    } finally {
      setBusy(false);
      setConfirmSuspend(false);
      setConfirmLift(false);
    }
  }

  if (org.suspension) {
    return (
      <section className="rounded-[var(--radius-card)] border border-error-border bg-error-bg p-5">
        <h2 className="text-base font-medium text-error-text">Suspended</h2>
        <p className="mt-1 text-sm text-error-text">
          Since <LocalDateTime value={org.suspension.since} />
          {org.suspension.by ? <> · by operator <code className="text-xs">{org.suspension.by}</code></> : null}
        </p>
        <p className="mt-3 text-sm text-foreground">{org.suspension.reason ?? "No reason recorded."}</p>
        <p className="mt-3 text-xs text-muted">
          The storefront is offline, checkouts, downloads and renewals are halted, and every write except
          billing answers 403 ACCOUNT_SUSPENDED. Reads still work. Paying does not lift this; only you do.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmLift(true)}>
            Lift suspension
          </Button>
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
        <ConfirmDialog
          open={confirmLift}
          title={`Reinstate ${org.name}?`}
          description="Standing returns to whatever billing says — a lapsed trial or a dunning hold still applies on its own terms. This is recorded in the merchant's audit log."
          confirmLabel="Reinstate"
          busy={busy}
          onConfirm={() => void run(() => unsuspendPlatformOrg(org.id))}
          onClose={() => setConfirmLift(false)}
        />
      </section>
    );
  }

  const reasonOk = reason.trim().length >= 3;

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <h2 className="text-base font-medium text-foreground">Suspend this organization</h2>
      <p className="mt-1 text-sm text-muted">
        Takes every storefront offline on the next request and refuses their writes until an operator
        lifts it. Their data stays intact and readable; their billing page stays open so they can cancel.
      </p>
      <div className="mt-4">
        <Label htmlFor="suspend-reason">Reason</Label>
        <Textarea
          id="suspend-reason"
          rows={3}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. 40 sign-ups from one domain in a day; awaiting a reply to our email of 15 Sep."
        />
        <p className="mt-1.5 text-xs text-muted">
          Required. <strong>The merchant&apos;s owner and administrators can read this</strong> in their
          audit log — write it as the thing you would say to them.
        </p>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button disabled={busy || !reasonOk} onClick={() => setConfirmSuspend(true)}>
          Suspend
        </Button>
        {error ? <FieldError>{error}</FieldError> : null}
      </div>
      <ConfirmDialog
        open={confirmSuspend}
        title={`Suspend ${org.name}?`}
        description={`Every storefront under ${org.slug} goes offline immediately. You will be asked for a fresh second factor.`}
        confirmLabel="Suspend"
        danger
        busy={busy}
        onConfirm={() => void run(() => suspendPlatformOrg(org.id, reason.trim()))}
        onClose={() => setConfirmSuspend(false)}
      />
    </section>
  );
}
