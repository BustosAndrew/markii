"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ShoppingBag } from "lucide-react";
import {
  disconnectIntegration,
  putGoogle,
  syncGoogle,
  type IntegrationsResponse,
} from "@/lib/api/integrations";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Textarea } from "@/components/ui/field";

export function IntegrationsPanel({
  initial,
}: {
  initial: IntegrationsResponse;
}) {
  const router = useRouter();
  const [google, setGoogle] = useState(initial.google);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const googleJsonRef = useRef<HTMLTextAreaElement>(null);

  async function refresh() {
    router.refresh();
  }

  const connected = google.status === "connected";

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-muted">
        Catalog and product feeds. Payment rails (Stripe, x402) are under{" "}
        <Link href="/dashboard/payments" className="font-medium text-brand hover:text-brand-hover">
          Payments
        </Link>
        .
      </p>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span
              aria-hidden
              className={`flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${
                connected ? "bg-brand/10 text-brand" : "bg-hover text-muted"
              }`}
            >
              <ShoppingBag className="size-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                Google Merchant Center
              </h2>
              <p className="mt-1 text-sm text-muted">
                Optional product sync. Service account JSON is never stored in the browser after
                submit.
              </p>
              {google.status === "error" && google.message ? (
                <p className="mt-2 text-sm text-error-text">{google.message}</p>
              ) : null}
            </div>
          </div>
          <Badge
            variant={
              google.status === "connected"
                ? "success"
                : google.status === "error"
                  ? "error"
                  : "neutral"
            }
          >
            {google.status === "connected"
              ? "Connected"
              : google.status === "error"
                ? "Error"
                : "Not connected"}
          </Badge>
        </div>

        {google.status === "connected" && google.merchantId ? (
          <p className="mb-3 text-sm text-muted">
            Merchant ID {google.merchantId}
            {google.lastSyncAt
              ? ` · last sync ${new Date(google.lastSyncAt).toLocaleString()}`
              : ""}
          </p>
        ) : null}

        <GoogleForm
          jsonRef={googleJsonRef}
          busy={busy}
          onSave={async (merchantId, serviceAccountJson) => {
            setBusy(true);
            setError(null);
            setSyncMessage(null);
            try {
              const next = await putGoogle({ merchantId, serviceAccountJson });
              setGoogle(next);
              await refresh();
            } catch (err) {
              setError(publicErrorMessage(err, "Save failed."));
            } finally {
              if (googleJsonRef.current) googleJsonRef.current.value = "";
              setBusy(false);
            }
          }}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {google.status === "connected" ? (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  setSyncMessage(null);
                  try {
                    const result = await syncGoogle();
                    setSyncMessage(
                      `Synced ${result.synced} · failed ${result.failed}`,
                    );
                    await refresh();
                  } catch (err) {
                    setError(publicErrorMessage(err, "Sync failed."));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sync products
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-error-text"
                disabled={busy}
                onClick={() => setDisconnectOpen(true)}
              >
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
        {syncMessage ? (
          <p className="mt-2 text-sm text-muted">{syncMessage}</p>
        ) : null}
      </section>

      <FieldError>{error}</FieldError>

      <ConfirmDialog
        open={disconnectOpen}
        title="Disconnect Google Merchant Center?"
        description="Product sync stops until you reconnect. Existing catalog data in Markii is unchanged."
        confirmLabel="Disconnect"
        danger
        busy={busy}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await disconnectIntegration("google");
            setGoogle({
              status: "not_connected",
              merchantId: null,
              lastSyncAt: null,
            });
            setDisconnectOpen(false);
            await refresh();
          } catch (err) {
            setError(publicErrorMessage(err, "Disconnect failed."));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function GoogleForm({
  busy,
  onSave,
  jsonRef,
}: {
  busy: boolean;
  onSave: (merchantId: string, serviceAccountJson: string) => Promise<void>;
  jsonRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [merchantId, setMerchantId] = useState("");
  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const json = jsonRef.current?.value?.trim() ?? "";
        void onSave(merchantId.trim(), json);
      }}
    >
      <div>
        <Label htmlFor="merchant-id">Merchant ID</Label>
        <Input
          id="merchant-id"
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          placeholder="123456"
          autoComplete="off"
          required
        />
      </div>
      <div>
        <Label htmlFor="sa-json">Service account JSON</Label>
        <Textarea
          id="sa-json"
          ref={jsonRef}
          rows={5}
          placeholder='{"type":"service_account",…}'
          autoComplete="off"
          spellCheck={false}
          required
          className="font-mono text-xs"
        />
      </div>
      <Button type="submit" disabled={busy}>
        Connect Google
      </Button>
    </form>
  );
}
