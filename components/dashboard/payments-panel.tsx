"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CreditCard, ExternalLink, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  connectRail,
  disconnectRail,
  startStripeConnect,
  type PaymentsResponse,
  type RailStatus,
} from "@/lib/api/payments";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label } from "@/components/ui/field";

function railById(rails: RailStatus[], rail: RailStatus["rail"]) {
  return rails.find((r) => r.rail === rail);
}

export function PaymentsPanel({
  initial,
  flash,
  flashReason,
}: {
  initial: PaymentsResponse;
  flash?: "connected" | "cancelled" | "error" | null;
  flashReason?: string | null;
}) {
  const router = useRouter();
  const [rails, setRails] = useState(initial.rails);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<"x402" | "stripe" | null>(
    null,
  );

  const x402 = railById(rails, "x402") ?? {
    rail: "x402" as const,
    status: "not_connected" as const,
    canAcceptPayments: false,
  };
  const stripe = railById(rails, "stripe") ?? {
    rail: "stripe" as const,
    status: "not_connected" as const,
    canAcceptPayments: false,
  };

  async function refresh() {
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {flash === "connected" ? (
        <p className="rounded-[var(--radius-control)] bg-success-bg px-4 py-3 text-sm text-success-text">
          Stripe is connected. Card checkout turns on once Stripe enables charges on your account.
        </p>
      ) : null}
      {flash === "cancelled" ? (
        <p className="rounded-[var(--radius-control)] border border-border bg-surface-elevated px-4 py-3 text-sm text-muted">
          Stripe connection was cancelled. Nothing changed.
        </p>
      ) : null}
      {flash === "error" ? (
        <p className="rounded-[var(--radius-control)] bg-error-bg px-4 py-3 text-sm text-error-text">
          Could not finish connecting Stripe
          {flashReason ? `: ${flashReason}` : "."}
        </p>
      ) : null}

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <p className="text-sm leading-6 text-muted">{initial.balancesNote}</p>
        <p className="mt-3 text-sm text-muted">
          For sales volume across every rail, see{" "}
          <Link href="/dashboard/orders/settlements" className="font-medium text-brand hover:text-brand-hover">
            Orders → Settlements
          </Link>
          .
        </p>
      </section>

      <RailCard
        title="x402 / USDC"
        description="Receiving wallet for agent checkout. Changing this redirects where USDC settles."
        icon={Wallet}
        rail={x402}
      >
        {x402.status === "connected" && x402.walletAddress ? (
          <p className="mb-3 break-all font-mono text-xs text-muted">
            {x402.walletAddress}
          </p>
        ) : null}
        <p className="mb-3 text-sm text-muted">
          {x402.canAcceptPayments
            ? "This rail can accept payments."
            : "Connect a wallet before storefronts can take x402 payments."}
        </p>
        <X402Form
          busy={busy}
          onSave={async (walletAddress) => {
            setBusy(true);
            setError(null);
            try {
              const next = await connectRail("x402", { walletAddress });
              setRails((prev) =>
                prev.map((r) =>
                  r.rail === "x402"
                    ? {
                        rail: "x402",
                        status: next.status,
                        canAcceptPayments:
                          next.status === "connected" && Boolean(next.walletAddress),
                        walletAddress: next.walletAddress ?? walletAddress,
                        message: next.message,
                      }
                    : r,
                ),
              );
              await refresh();
            } catch (err) {
              setError(publicErrorMessage(err, "Could not save wallet."));
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
      </RailCard>

      <RailCard
        title="Stripe"
        description="Card payments through Connect Standard. You keep your own Stripe account, rates, dashboard, and payouts."
        icon={CreditCard}
        rail={stripe}
      >
        {stripe.status === "connected" ? (
          <StripeConnectedBody
            stripe={stripe}
            busy={busy}
            onReconnect={async () => {
              setBusy(true);
              setError(null);
              try {
                const { url } = await startStripeConnect();
                window.location.href = url;
              } catch (err) {
                setError(publicErrorMessage(err, "Could not start the Stripe connection."));
                setBusy(false);
              }
            }}
            onDisconnect={() => setDisconnectTarget("stripe")}
          />
        ) : (
          <>
            <p className="mb-3 text-sm leading-6 text-muted">
              You will be sent to Stripe to authorise. Markii never asks for your secret key.
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const { url } = await startStripeConnect();
                  window.location.href = url;
                } catch (err) {
                  setError(publicErrorMessage(err, "Could not start the Stripe connection."));
                  setBusy(false);
                }
              }}
            >
              Connect with Stripe
            </Button>
          </>
        )}
      </RailCard>

      {initial.stores.length > 0 ? (
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Per storefront
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            A rail can be connected here and still switched off on an individual site. Toggle rails
            on each website&rsquo;s settings.
          </p>
          <ul className="mt-4 divide-y divide-border">
            {initial.stores.map((store) => (
              <li
                key={store.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/dashboard/websites/${store.slug}`}
                    className="font-medium text-foreground hover:text-brand"
                  >
                    {store.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {[
                      store.enabled.x402 ? "x402 on" : "x402 off",
                      store.enabled.stripe ? "Stripe on" : "Stripe off",
                      store.walletAddressOverride
                        ? "custom wallet"
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={store.enabled.x402 && x402.canAcceptPayments ? "success" : "neutral"}>
                    x402
                  </Badge>
                  <Badge
                    variant={
                      store.enabled.stripe && stripe.canAcceptPayments ? "success" : "neutral"
                    }
                  >
                    Stripe
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <FieldError>{error}</FieldError>

      <ConfirmDialog
        open={disconnectTarget !== null}
        title="Disconnect payment rail?"
        description="Storefronts that rely on this rail will stop accepting payment that way until you reconnect."
        confirmLabel="Disconnect"
        danger
        busy={busy}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={async () => {
          if (!disconnectTarget) return;
          setBusy(true);
          setError(null);
          try {
            await disconnectRail(disconnectTarget);
            setRails((prev) =>
              prev.map((r) =>
                r.rail === disconnectTarget
                  ? {
                      rail: disconnectTarget,
                      status: "not_connected",
                      canAcceptPayments: false,
                      walletAddress: null,
                      accountId: null,
                      chargesEnabled: false,
                      payoutsEnabled: false,
                      requirementsDue: [],
                    }
                  : r,
              ),
            );
            setDisconnectTarget(null);
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

function StripeConnectedBody({
  stripe,
  busy,
  onReconnect,
  onDisconnect,
}: {
  stripe: RailStatus;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const ready = stripe.canAcceptPayments;
  return (
    <div className="space-y-4">
      <div
        className={cn(
          "rounded-[var(--radius-control)] px-4 py-3",
          ready ? "bg-success-bg" : "bg-warning-bg",
        )}
      >
        <p
          className={cn(
            "text-sm font-medium",
            ready ? "text-success-text" : "text-warning-text",
          )}
        >
          {ready
            ? "Card payments are live"
            : "Connected — charges are not enabled yet"}
        </p>
        <p
          className={cn(
            "mt-1 text-sm leading-6",
            ready ? "text-success-text" : "text-warning-text",
          )}
        >
          {ready
            ? "Checkout can take cards. Money settles to your Stripe account — Markii never holds it."
            : "Card checkout stays off on every storefront until Stripe enables charges on this account."}
        </p>
        {stripe.requirementsDue && stripe.requirementsDue.length > 0 ? (
          <p className="mt-2 text-sm leading-6 text-warning-text">
            Outstanding: {stripe.requirementsDue.join(", ")}.
          </p>
        ) : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated px-3 py-2.5">
          <dt className="text-xs text-muted">Charges</dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground">
            {stripe.chargesEnabled ? "Enabled" : "Not enabled"}
          </dd>
        </div>
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated px-3 py-2.5">
          <dt className="text-xs text-muted">Payouts</dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground">
            {stripe.payoutsEnabled ? "Enabled" : "Not enabled"}
          </dd>
        </div>
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated px-3 py-2.5">
          <dt className="text-xs text-muted">Account</dt>
          <dd className="mt-0.5 truncate font-mono text-xs text-foreground" title={stripe.accountId ?? undefined}>
            {stripe.accountId ?? "—"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink
          href="https://dashboard.stripe.com"
          target="_blank"
          rel="noopener noreferrer"
          variant="secondary"
        >
          Open Stripe dashboard
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </ButtonLink>
        <Button type="button" variant="secondary" disabled={busy} onClick={onReconnect}>
          Reconnect
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="text-error-text"
          disabled={busy}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

function RailCard({
  title,
  description,
  icon: Icon,
  rail,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  rail: RailStatus;
  children: React.ReactNode;
}) {
  const ready = rail.canAcceptPayments;
  return (
    <section
      className={cn(
        "rounded-[var(--radius-card)] border bg-surface p-5 shadow-[var(--shadow-sm)]",
        ready ? "border-success-text/25" : "border-border",
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span
            aria-hidden
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
              ready ? "bg-success-bg text-success-text" : "bg-hover text-muted",
            )}
          >
            <Icon className="size-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <p className="mt-1 text-sm text-muted">{description}</p>
            {rail.status === "error" && rail.message ? (
              <p className="mt-2 text-sm text-error-text">{rail.message}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={rail.status === "connected" ? "success" : rail.status === "error" ? "error" : "neutral"}>
            {rail.status === "connected"
              ? "Connected"
              : rail.status === "error"
                ? "Error"
                : "Not connected"}
          </Badge>
          <Badge variant={ready ? "success" : "neutral"}>
            {ready ? "Taking payments" : "Not taking payments"}
          </Badge>
        </div>
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
