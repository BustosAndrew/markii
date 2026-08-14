"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { updatePassword } from "@/lib/api/auth";
import { isPlannedError } from "@/lib/api/planned";
import { ApiClientError } from "@/lib/api/types";

/**
 * Second step of password recovery: the form that actually sets the new
 * password. Rendered only when `/reset-password` finds a session, because the
 * browser is never given one to check itself (D30).
 */
export function SetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Saves a round trip only. The server owns the password rules; `confirm`
    // is the one thing it cannot check, since it never sees it.
    if (password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }

    setPending(true);
    try {
      await updatePassword({ password });
      /**
       * The session survives the change and is still `aal1`, so send them
       * through the same gate sign-in uses rather than to /dashboard. A reset
       * link must not become a way around MFA (D40).
       */
      router.replace("/mfa?next=/dashboard");
      router.refresh();
    } catch (caught) {
      if (isPlannedError(caught)) {
        setError("Merchant auth isn’t available on this deployment yet. Nothing was changed.");
      } else if (caught instanceof ApiClientError && caught.status === 401) {
        // The session expired between loading this page and submitting it.
        setError("That reset link has expired. Request a new one to continue.");
      } else if (caught instanceof Error) {
        setError(caught.message);
      } else {
        setError("Request failed. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-6 py-12">
      <div className="w-full rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={32} />
          <div>
            <p className="text-base font-semibold tracking-tight text-foreground">markii</p>
            <p className="text-sm text-muted">Merchant auth</p>
          </div>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Set a new password
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Choose a new password for your Markii merchant account.
        </p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <fieldset disabled={pending} className="space-y-4">
            <div>
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <p className="mt-1.5 text-sm text-muted">At least 8 characters.</p>
            </div>

            <div>
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
              />
            </div>

            <Button type="submit" className="w-full">
              {pending ? "Working..." : "Update password"}
            </Button>
          </fieldset>

          <p aria-live="polite" className="empty:hidden">
            {error ? <span className="text-sm text-error-text">{error}</span> : null}
          </p>
        </form>

        <div className="mt-6 text-sm">
          <Link href="/sign-in" className="text-muted hover:text-foreground">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
