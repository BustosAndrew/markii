"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { updateOrg } from "@/lib/api/org";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

/**
 * The current organization's name. Owner / administrator only — `org.write`.
 * Distinct from the signed-in user's username: a person can belong to more
 * than one org.
 */
export function OrgNameForm({ currentName }: { currentName: string }) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const org = await updateOrg({ name });
      setName(org.name);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(publicErrorMessage(err, "The organization name could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Organization name</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        The company name for this organization. Your team sees it in the
        sidebar. Changing it does not change the storefront URL.
      </p>

      <form className="mt-4 max-w-md" onSubmit={(e) => void onSubmit(e)}>
        <Label htmlFor="org-name">Company name</Label>
        <Input
          id="org-name"
          type="text"
          autoComplete="organization"
          maxLength={200}
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
            {busy ? "Saving…" : "Update organization name"}
          </Button>
        </div>
      </form>
    </section>
  );
}
