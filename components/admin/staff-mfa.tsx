"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Label, Textarea } from "@/components/ui/field";
import { resetPlatformMfa, type PlatformOrgView } from "@/lib/api/admin";
import { ApiClientError } from "@/lib/api/types";

type Member = PlatformOrgView["staff"][number];

/**
 * An org's members and their MFA state, with the operator's reset (G12,
 * `platform.resetMfa`).
 *
 * The verification box is the point of the form. This is the one operator
 * action an impersonator wants — "I lost my phone, please remove the
 * authenticator" — so the form asks how identity was confirmed and records the
 * answer in the org's audit log beside the reset.
 */
export function StaffMfa({ org }: { org: PlatformOrgView }) {
  const router = useRouter();
  const [target, setTarget] = useState<Member | null>(null);
  const [verification, setVerification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function reset() {
    if (!target?.userId) return;
    setBusy(true);
    setError(null);
    try {
      const out = await resetPlatformMfa(org.id, target.userId, verification.trim());
      setDone(
        `Reset ${target.email}: ${out.result?.factorsRemoved ?? 0} authenticator(s) removed, ` +
          `${out.result?.sessionsEnded ?? 0} session(s) ended. A notice was queued to ` +
          `${out.result?.noticeTo ?? "their account email"}.`,
      );
      setTarget(null);
      setVerification("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Reset failed.");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <h2 className="text-base font-medium text-foreground">Members</h2>
      {org.staff.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No members.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {org.staff.map((m) => (
            <li key={m.email} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{m.email}</span>
                <span className="capitalize text-muted">{m.role.replace("_", " ")}</span>
                {m.status !== "active" ? <Badge variant="neutral">{m.status}</Badge> : null}
                {m.userId ? (
                  m.mfaEnrolled ? (
                    <Badge variant="success">MFA on</Badge>
                  ) : (
                    <Badge variant="warning">No authenticator</Badge>
                  )
                ) : null}
              </span>
              {m.userId && m.mfaEnrolled ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setTarget(m);
                    setDone(null);
                    setError(null);
                  }}
                >
                  Reset MFA
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {done ? <p className="mt-3 text-sm text-success-text">{done}</p> : null}

      {target ? (
        <div className="mt-4 rounded-[var(--radius-card)] border border-warning-border bg-warning-bg p-4">
          <p className="text-sm text-warning-text">
            <strong>Reset two-factor for {target.email}.</strong> Removes their authenticator, voids their
            recovery codes and signs them out everywhere. They re-enrol at next sign-in and are emailed
            that it happened.
          </p>
          <div className="mt-3">
            <Label htmlFor="mfa-verification">How did you confirm it is them?</Label>
            <Textarea
              id="mfa-verification"
              rows={3}
              value={verification}
              disabled={busy}
              onChange={(e) => setVerification(e.target.value)}
              placeholder="e.g. Replied from the account email, matched the last order number and the card's last four."
            />
            <p className="mt-1.5 text-xs text-muted">
              Required. Recorded in this organization&apos;s audit log. An email alone is weak evidence if
              the mailbox is the thing that was compromised.
            </p>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button disabled={busy || verification.trim().length < 10} onClick={() => setConfirmOpen(true)}>
              Reset MFA
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            {error ? <FieldError>{error}</FieldError> : null}
          </div>
        </div>
      ) : error ? (
        <div className="mt-3">
          <FieldError>{error}</FieldError>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={`Reset two-factor for ${target?.email ?? ""}?`}
        description="Their authenticator is deleted at Supabase and cannot be restored. You will be asked for a fresh second factor."
        confirmLabel="Reset"
        danger
        busy={busy}
        onConfirm={() => void reset()}
        onClose={() => setConfirmOpen(false)}
      />
    </section>
  );
}
