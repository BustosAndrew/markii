"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { updateName } from "@/lib/api/auth";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

/**
 * The signed-in user's display name. It can be a person or a company — it is
 * not a unique handle and does not change the organization slug.
 */
export function UsernameForm({ currentName }: { currentName: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(currentName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await updateName({ name });
      setName(result.name);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(publicErrorMessage(err, "That name could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Username</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        How you appear to your team — your name, a company name, or anything
        else you want shown. This is not a unique handle and it does not change
        your storefront address.
      </p>

      <form className="mt-4 max-w-md" onSubmit={(e) => void onSubmit(e)}>
        <Label htmlFor="account-name">Name</Label>
        <Input
          id="account-name"
          type="text"
          autoComplete="nickname"
          maxLength={80}
          required
          value={name}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <FieldError>{error}</FieldError>
        {saved ? (
          <p className="mt-1.5 text-sm text-success-text">Saved.</p>
        ) : null}
        <div className="mt-3">
          <Button type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Saving…" : currentName ? "Update username" : "Set username"}
          </Button>
        </div>
      </form>
    </section>
  );
}
