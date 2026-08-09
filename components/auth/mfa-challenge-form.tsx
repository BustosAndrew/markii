"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { verifyMfaCode } from "@/lib/api/mfa";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { MfaShell } from "./mfa-shell";

export function MfaChallengeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/dashboard";
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyMfaCode({ code: code.trim() });
      router.replace(next.startsWith("/") ? next : "/dashboard");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.replace("/sign-in");
        return;
      }
      setError(err instanceof Error ? err.message : "That code did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <MfaShell
      title="Enter your authentication code"
      description="Open your authenticator app and type the 6-digit code for Markii."
    >
      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <Label htmlFor="mfa-challenge-code">Authentication code</Label>
          <Input
            id="mfa-challenge-code"
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
        <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>
          {busy ? "Checking…" : "Verify"}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Lost your authenticator?{" "}
        <Link
          href={`/mfa/recover?next=${encodeURIComponent(next)}`}
          className="text-foreground underline-offset-2 hover:underline"
        >
          Use a recovery code
        </Link>
      </p>
    </MfaShell>
  );
}
