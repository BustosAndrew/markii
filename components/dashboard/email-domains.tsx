"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  addSendingDomain,
  removeSendingDomain,
  verifySendingDomain,
  type SendingDomain,
} from "@/lib/api/email";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";

const STATUS_VARIANT: Record<SendingDomain["status"], "success" | "warning" | "error" | "neutral"> =
  {
    verified: "success",
    pending: "neutral",
    temporary_failure: "warning",
    failed: "error",
  };

const STATUS_LABEL: Record<SendingDomain["status"], string> = {
  verified: "Verified",
  pending: "Awaiting DNS",
  temporary_failure: "Temporary failure",
  failed: "Failed",
};

export function EmailDomains({
  domains,
  providerConfigured,
}: {
  domains: SendingDomain[];
  providerConfigured: boolean;
}) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SendingDomain | null>(null);

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
      <h2 className="text-base font-medium text-foreground">Sending domains</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Customer mail is sent from a domain you own and have verified. Markii never sends it from
        markii.shop on your behalf — your bounces must not land on Markii’s sending reputation.
      </p>

      {domains.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No sending domain yet, so no customer email is going out.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {domains.map((d) => (
            <li
              key={d.id}
              className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{d.domain}</p>
                  <p className="mt-1 text-sm text-muted">Sends as {d.senderAddress}</p>
                </div>
                <Badge variant={STATUS_VARIANT[d.status]}>{STATUS_LABEL[d.status]}</Badge>
              </div>

              {d.problem ? (
                <p className="mt-3 text-sm leading-6 text-warning-text">{d.problem}</p>
              ) : null}

              {/*
                DNS records are derived from the tokens SES expects right now, not
                a stored copy — so a merchant who rotated them sees the current
                ones rather than records that will never verify.
              */}
              {d.status !== "verified" && d.dns.length > 0 ? (
                <div className="mt-3">
                  <p className="text-sm text-muted">
                    Publish these CNAME records with your DNS provider, then check again.
                  </p>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-4 font-medium">Type</th>
                          <th className="py-1 pr-4 font-medium">Name</th>
                          <th className="py-1 font-medium">Value</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono text-foreground">
                        {d.dns.map((r) => (
                          <tr key={r.name} className="border-t border-border">
                            <td className="py-1.5 pr-4">{r.type}</td>
                            <td className="py-1.5 pr-4 break-all">{r.name}</td>
                            <td className="py-1.5 break-all">{r.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                {/*
                  Verification is a pull: nothing in this deployment schedules
                  jobs, so this button is how a merchant finds out DNS propagated.
                */}
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`verify-${d.id}`, () => verifySendingDomain({ identityId: d.id }))
                  }
                >
                  {busy === `verify-${d.id}` ? "Checking…" : "Check verification"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => setRemoving(d)}
                >
                  Remove
                </Button>
              </div>

              {d.lastCheckedAt ? (
                <p className="mt-2 text-xs text-muted">
                  Last checked {new Date(d.lastCheckedAt).toLocaleString()}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {providerConfigured ? (
        <form
          className="mt-5 border-t border-border pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = domain.trim();
            if (!value) return;
            void run("add", async () => {
              await addSendingDomain({ domain: value });
              setDomain("");
            });
          }}
        >
          <Label htmlFor="sending-domain">Add a sending domain</Label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Input
              id="sending-domain"
              value={domain}
              placeholder="store.example.com"
              disabled={busy !== null}
              onChange={(e) => setDomain(e.target.value)}
              className="max-w-sm"
            />
            <Button type="submit" disabled={busy !== null || domain.trim() === ""}>
              {busy === "add" ? "Adding…" : "Add domain"}
            </Button>
          </div>
        </form>
      ) : (
        /*
          No AWS credentials means adding a domain would fail at SES after the
          merchant filled the field. Not offering the form is more honest than
          offering one that cannot succeed.
        */
        <p className="mt-5 border-t border-border pt-5 text-sm leading-6 text-muted">
          Adding a sending domain needs Markii’s email provider to be connected first. Nothing you
          enter here could be registered with AWS yet, so the form is hidden rather than shown and
          made to fail.
        </p>
      )}

      {error ? <FieldError>{error}</FieldError> : null}

      <ConfirmDialog
        open={removing !== null}
        danger={removing?.status === "verified"}
        busy={busy?.startsWith("remove-") ?? false}
        title={`Remove ${removing?.domain ?? ""}?`}
        description={
          removing?.status === "verified"
            ? "This stops every customer email immediately — order confirmations, shipping notices, " +
              "and digital delivery. Nothing will error; your customers will simply stop hearing " +
              "from you."
            : "This domain is not verified, so no mail is being sent from it yet."
        }
        confirmLabel="Remove domain"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) {
            void run(`remove-${target.id}`, () =>
              removeSendingDomain({ identityId: target.id }),
            );
          }
        }}
      />
    </section>
  );
}
