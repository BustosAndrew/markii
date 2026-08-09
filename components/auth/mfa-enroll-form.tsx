"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  completeMfaEnrolment,
  startMfaEnrolment,
  type MfaEnrolStart,
} from "@/lib/api/mfa";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { MfaShell } from "./mfa-shell";

export function MfaEnrollForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/dashboard";

  const [start, setStart] = useState<MfaEnrolStart | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await startMfaEnrolment();
        if (!cancelled) setStart(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 409) {
          // Already enrolled — send them to challenge or dashboard.
          router.replace(`/mfa/challenge?next=${encodeURIComponent(next)}`);
          return;
        }
        if (err instanceof ApiClientError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        setError(err instanceof Error ? err.message : "Could not start setup.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [next, router]);

  async function onConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!start) return;
    setBusy(true);
    setError(null);
    try {
      const result = await completeMfaEnrolment({
        factorId: start.factorId,
        code: code.trim(),
      });
      setRecoveryCodes(result.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work.");
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (!savedAck) return;
    router.replace(next.startsWith("/") ? next : "/dashboard");
    router.refresh();
  }

  function downloadCodes(codes: string[]) {
    const blob = new Blob(
      [
        "Markii recovery codes\n",
        "Each code works once. Store these somewhere safe.\n\n",
        codes.join("\n"),
        "\n",
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "markii-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (recoveryCodes) {
    return (
      <MfaShell
        title="Save your recovery codes"
        description="These are shown once. If you lose your authenticator, they are the only way back in."
      >
        <ul className="grid grid-cols-1 gap-2 rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4 font-mono text-sm sm:grid-cols-2">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(recoveryCodes.join("\n"))}
          >
            Copy
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => downloadCodes(recoveryCodes)}
          >
            Download
          </Button>
        </div>
        <label className="mt-5 flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-1"
            checked={savedAck}
            onChange={(e) => setSavedAck(e.target.checked)}
          />
          <span>I have saved these codes somewhere I can find them later.</span>
        </label>
        <Button
          type="button"
          className="mt-4 w-full"
          disabled={!savedAck}
          onClick={finish}
        >
          Continue to dashboard
        </Button>
      </MfaShell>
    );
  }

  return (
    <MfaShell
      title="Set up two-factor authentication"
      description="Merchant accounts need an authenticator app. Scan the code, then enter a 6-digit code to finish."
    >
      {loading ? (
        <p className="text-sm text-muted">Preparing setup…</p>
      ) : start ? (
        <form className="space-y-5" onSubmit={(e) => void onConfirm(e)}>
          <div className="flex flex-col items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={start.qrCode}
              alt="Authenticator QR code"
              className="size-44 rounded-md bg-white p-2"
            />
            <p className="text-center text-xs leading-5 text-muted">
              Camera not working? Enter this secret manually:
            </p>
            <code className="break-all text-center font-mono text-xs text-foreground">
              {start.secret}
            </code>
          </div>
          <div>
            <Label htmlFor="mfa-enroll-code">Verification code</Label>
            <Input
              id="mfa-enroll-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              disabled={busy}
            />
          </div>
          {error ? <p className="text-sm text-error-text">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>
            {busy ? "Checking…" : "Confirm and continue"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-error-text">
          {error ?? "Setup could not start."}
        </p>
      )}
    </MfaShell>
  );
}
