"use client";

import { useState } from "react";
import { updateEmail } from "@/lib/api/auth";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

/**
 * Requests an address change. The current address stays on the account until
 * both confirmation mails are followed — `pending` is the destination, never
 * something to render as the signed-in email.
 */
export function EmailChangeForm({ currentEmail }: { currentEmail: string | null }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPending(null);
    setMessage(null);
    try {
      const result = await updateEmail({ email });
      setPending(result.pending);
      setMessage(result.message);
      setEmail("");
    } catch (err) {
      setError(publicErrorMessage(err, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Email address</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Changing it sends a confirmation to the address on the account and to
        the new one. Both have to be followed before the account moves.
      </p>

      <p className="mt-4 text-sm text-foreground">
        <span className="text-muted">On this account: </span>
        {currentEmail ?? "None recorded"}
      </p>

      {pending && message ? (
        <p className="mt-3 rounded-[var(--radius-control)] bg-info-bg px-3 py-2 text-sm leading-6 text-info-text">
          {message} Waiting on confirmation for {pending} — that is not yet the
          address on the account.
        </p>
      ) : null}

      <form className="mt-4 max-w-md" onSubmit={(e) => void onSubmit(e)}>
        <Label htmlFor="account-email">New address</Label>
        <Input
          id="account-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FieldError>{error}</FieldError>
        <div className="mt-3">
          <Button type="submit" disabled={busy || email.trim() === ""}>
            {busy ? "Sending…" : "Send confirmation"}
          </Button>
        </div>
      </form>
    </section>
  );
}
