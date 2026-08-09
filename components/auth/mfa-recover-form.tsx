"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { recoverMfa } from "@/lib/api/mfa";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { MfaShell } from "./mfa-shell";

export function MfaRecoverForm() {
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
      await recoverMfa({ code: code.trim() });
      // Recovery removes the factor and requires enrolment — never the dashboard.
      router.replace(`/mfa/enroll?next=${encodeURIComponent(next)}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.replace("/sign-in");
        return;
      }
      setError(err instanceof Error ? err.message : "That recovery code did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <MfaShell
      title="Use a recovery code"
      description="Each code works once. After this, you will set up a new authenticator before you can use the dashboard again."
    >
      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <Label htmlFor="mfa-recover-code">Recovery code</Label>
          <Input
            id="mfa-recover-code"
            name="code"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            disabled={busy}
          />
        </div>
        {error ? <p className="text-sm text-error-text">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={busy || !code.trim()}>
          {busy ? "Checking…" : "Recover account"}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Still have your authenticator?{" "}
        <Link
          href={`/mfa/challenge?next=${encodeURIComponent(next)}`}
          className="text-foreground underline-offset-2 hover:underline"
        >
          Enter a code instead
        </Link>
      </p>
    </MfaShell>
  );
}
