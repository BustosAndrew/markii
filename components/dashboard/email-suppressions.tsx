"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { suppressAddress, unsuppressAddress, type Suppression } from "@/lib/api/email";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/field";

const REASON_LABEL: Record<Suppression["reason"], string> = {
  bounce: "Bounced",
  complaint: "Reported as spam",
  manual: "Added by you",
};

const REASON_VARIANT: Record<Suppression["reason"], "warning" | "error" | "neutral"> = {
  bounce: "warning",
  complaint: "error",
  manual: "neutral",
};

/**
 * The suppression list is not housekeeping — it is what keeps the SES account
 * alive. AWS suspends above roughly 5% bounce or 0.1% complaint measured across
 * the **whole account**, so one merchant mailing dead addresses can cut off
 * every merchant on the platform.
 */
export function EmailSuppressions({ suppressions }: { suppressions: Suppression[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Suppressed addresses</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Addresses that will not receive customer email. Permanent bounces and spam complaints land
        here automatically; continuing to mail them puts every store on Markii at risk of a sending
        suspension.
      </p>

      {suppressions.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">Nothing is suppressed.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {suppressions.map((s) => (
            <li key={s.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{s.email}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(s.createdAt).toLocaleDateString()}
                  {s.detail ? ` · ${s.detail}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={REASON_VARIANT[s.reason]}>{REASON_LABEL[s.reason]}</Badge>
                {/*
                  A complaint is the recipient's decision, and the action refuses
                  it. Offering a button that is guaranteed to be rejected would
                  be worse than explaining why there isn't one.
                */}
                {s.removable ? (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`remove-${s.email}`, () => unsuppressAddress({ email: s.email }))
                    }
                  >
                    {busy === `remove-${s.email}` ? "Removing…" : "Remove"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted">Cannot be re-enabled</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-5 border-t border-border pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          const value = email.trim();
          if (!value) return;
          void run("add", async () => {
            await suppressAddress({ email: value });
            setEmail("");
          });
        }}
      >
        <Label htmlFor="suppress-email">Suppress an address</Label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Input
            id="suppress-email"
            type="email"
            value={email}
            placeholder="customer@example.com"
            disabled={busy !== null}
            onChange={(e) => setEmail(e.target.value)}
            className="max-w-sm"
          />
          <Button type="submit" disabled={busy !== null || email.trim() === ""}>
            {busy === "add" ? "Adding…" : "Suppress"}
          </Button>
        </div>
      </form>

      {error ? <FieldError>{error}</FieldError> : null}
    </section>
  );
}
