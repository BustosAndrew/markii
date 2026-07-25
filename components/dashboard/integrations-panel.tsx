"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CreditCard, ShoppingBag, Wallet, type LucideIcon } from "lucide-react";
import {
  disconnectIntegration,
  putGoogle,
  putStripe,
  putX402,
  syncGoogle,
  type GoogleIntegration,
  type IntegrationsResponse,
  type StripeIntegration,
  type X402Integration,
} from "@/lib/api/integrations";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Textarea } from "@/components/ui/field";

function statusBadge(status: string) {
  if (status === "connected") return "success" as const;
  if (status === "error") return "error" as const;
  return "neutral" as const;
}

function statusLabel(status: string) {
  if (status === "connected") return "Connected";
  if (status === "error") return "Error";
  return "Not connected";
}

export function IntegrationsPanel({
  initial,
}: {
  initial: IntegrationsResponse;
}) {
  const router = useRouter();
  const [x402, setX402] = useState(initial.x402);
  const [google, setGoogle] = useState(initial.google);
  const [stripe, setStripe] = useState(initial.stripe);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<
    "x402" | "google" | "stripe" | null
  >(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const stripeKeyRef = useRef<HTMLInputElement>(null);
  const googleJsonRef = useRef<HTMLTextAreaElement>(null);

  async function refresh() {
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-card)] border border-warning-text/30 bg-warning-bg px-4 py-3 text-sm text-warning-text">
        Demo: unauthenticated admin. Do not paste production secrets — use test
        keys and non-prod service accounts only.
      </div>

      <ProviderCard
        title="x402 wallet"
        description="Default receiving wallet for new sites (Base Sepolia)."
        status={x402}
        icon={Wallet}
      >
        {x402.status === "connected" && x402.walletAddress ? (
          <p className="mb-3 break-all font-mono text-xs text-muted">
            {x402.walletAddress}
            {x402.network ? ` · ${x402.network}` : ""}
          </p>
        ) : null}
        <X402Form
          busy={busy}
          onSave={async (walletAddress) => {
            setBusy(true);
            setError(null);
            try {
              const next = await putX402({ walletAddress });
              setX402(next);
              await refresh();
            } catch (err) {
              setError(
                err instanceof ApiClientError ? err.message : "Save failed.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
        {x402.status === "connected" ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-3 text-error-text"
            disabled={busy}
            onClick={() => setDisconnectTarget("x402")}
          >
            Disconnect
          </Button>
        ) : null}
      </ProviderCard>

      <ProviderCard
        title="Google Merchant Center"
        description="Optional product sync. Service account JSON is never stored in the browser after submit."
        status={google}
        icon={ShoppingBag}
      >
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
              setError(
                err instanceof ApiClientError ? err.message : "Save failed.",
              );
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
                    setError(
                      err instanceof ApiClientError
                        ? err.message
                        : "Sync failed.",
                    );
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
                onClick={() => setDisconnectTarget("google")}
              >
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
        {syncMessage ? (
          <p className="mt-2 text-sm text-muted">{syncMessage}</p>
        ) : null}
      </ProviderCard>

      <ProviderCard
        title="Stripe"
        description="Optional fiat checkout. Paste a test secret key only — cleared from the form after connect."
        status={stripe}
        icon={CreditCard}
      >
        {stripe.status === "connected" && stripe.accountId ? (
          <p className="mb-3 text-sm text-muted">Account {stripe.accountId}</p>
        ) : null}
        <StripeForm
          keyRef={stripeKeyRef}
          busy={busy}
          onSave={async (secretKey) => {
            setBusy(true);
            setError(null);
            try {
              const next = await putStripe({ secretKey });
              setStripe(next);
              await refresh();
            } catch (err) {
              setError(
                err instanceof ApiClientError ? err.message : "Save failed.",
              );
            } finally {
              if (stripeKeyRef.current) stripeKeyRef.current.value = "";
              setBusy(false);
            }
          }}
        />
        {stripe.status === "connected" ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-3 text-error-text"
            disabled={busy}
            onClick={() => setDisconnectTarget("stripe")}
          >
            Disconnect
          </Button>
        ) : null}
      </ProviderCard>

      <FieldError>{error}</FieldError>

      <ConfirmDialog
        open={disconnectTarget !== null}
        title="Disconnect integration?"
        description="You can reconnect later. Existing site toggles may need updating."
        confirmLabel="Disconnect"
        danger
        busy={busy}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={async () => {
          if (!disconnectTarget) return;
          setBusy(true);
          setError(null);
          try {
            await disconnectIntegration(disconnectTarget);
            if (disconnectTarget === "x402") {
              setX402({ status: "not_connected", walletAddress: null });
            } else if (disconnectTarget === "google") {
              setGoogle({
                status: "not_connected",
                merchantId: null,
                lastSyncAt: null,
              });
            } else {
              setStripe({ status: "not_connected", accountId: null });
            }
            setDisconnectTarget(null);
            await refresh();
          } catch (err) {
            setError(
              err instanceof ApiClientError
                ? err.message
                : "Disconnect failed.",
            );
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function ProviderCard({
  title,
  description,
  status,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  status: X402Integration | GoogleIntegration | StripeIntegration;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  const connected = status.status === "connected";
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span
            aria-hidden
            className={`flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${
              connected ? "bg-brand/10 text-brand" : "bg-hover text-muted"
            }`}
          >
            <Icon className="size-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <p className="mt-1 text-sm text-muted">{description}</p>
            {status.status === "error" && status.message ? (
              <p className="mt-2 text-sm text-error-text">{status.message}</p>
            ) : null}
          </div>
        </div>
        <Badge variant={statusBadge(status.status)}>
          {statusLabel(status.status)}
        </Badge>
      </div>
      {children}
    </section>
  );
}

function X402Form({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (walletAddress: string) => Promise<void>;
}) {
  const [wallet, setWallet] = useState("");
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(wallet.trim());
      }}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor="wallet" className="sr-only">
          Wallet address
        </Label>
        <Input
          id="wallet"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      <Button type="submit" disabled={busy || !wallet.trim()}>
        Save wallet
      </Button>
    </form>
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

function StripeForm({
  busy,
  onSave,
  keyRef,
}: {
  busy: boolean;
  onSave: (secretKey: string) => Promise<void>;
  keyRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const secretKey = keyRef.current?.value?.trim() ?? "";
        void onSave(secretKey);
      }}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor="stripe-key" className="sr-only">
          Stripe secret key
        </Label>
        <Input
          id="stripe-key"
          ref={keyRef}
          type="password"
          placeholder="sk_test_…"
          autoComplete="new-password"
          required
        />
      </div>
      <Button type="submit" disabled={busy}>
        Connect Stripe
      </Button>
    </form>
  );
}
