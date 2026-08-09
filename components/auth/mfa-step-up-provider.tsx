"use client";

import { useEffect, useId, useState } from "react";
import { registerMfaStepUpHandler } from "@/lib/api/client";
import { verifyMfaCode } from "@/lib/api/mfa";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";

type Pending = {
  reason?: string;
  action?: string;
  resolve: (ok: boolean) => void;
};

/**
 * Registers the global step-up handler for money-moving actions.
 * Modal asks for a fresh TOTP code, then the API client retries the request.
 */
export function MfaStepUpProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    registerMfaStepUpHandler((details) => {
      return new Promise<boolean>((resolve) => {
        setCode("");
        setError(null);
        setPending({
          reason:
            details.gate.status === "challenge"
              ? "reason" in details.gate
                ? details.gate.reason
                : undefined
              : undefined,
          action: details.action,
          resolve,
        });
      });
    });
    return () => registerMfaStepUpHandler(null);
  }, []);

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
    setCode("");
    setError(null);
    setBusy(false);
  }

  async function onConfirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyMfaCode({ code: code.trim() });
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work.");
      setBusy(false);
    }
  }

  return (
    <>
      {children}
      {pending ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px]"
            aria-label="Cancel verification"
            onClick={() => !busy && close(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-md)]"
          >
            <h2
              id={titleId}
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Confirm it is you
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-muted">
              {pending.reason ??
                "This change needs a fresh authentication code before it can continue."}
            </p>
            <form className="mt-5 space-y-4" onSubmit={(e) => void onConfirm(e)}>
              <div>
                <Label htmlFor="mfa-step-up-code">Authentication code</Label>
                <Input
                  id="mfa-step-up-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  pattern="[0-9]*"
                  maxLength={10}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  disabled={busy}
                />
              </div>
              {error ? <p className="text-sm text-error-text">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => close(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || code.trim().length < 6}>
                  {busy ? "Checking…" : "Confirm"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
