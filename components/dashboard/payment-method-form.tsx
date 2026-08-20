"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { stripePromiseFor } from "@/components/dashboard/stripe-browser";
import {
  createSetupIntent,
  setDefaultPaymentMethod,
  type Subscription,
} from "@/lib/api/billing";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Button } from "@/components/ui/button";

function CardForm({ onDone }: { onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      const result = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (result.error) {
        setError(result.error.message ?? "Card could not be saved.");
        return;
      }
      const paymentMethodId =
        typeof result.setupIntent?.payment_method === "string"
          ? result.setupIntent.payment_method
          : result.setupIntent?.payment_method?.id;
      if (!paymentMethodId) {
        setError("Stripe did not return a payment method.");
        return;
      }
      // Collecting a card is not using it — invoices need the default set.
      const applied = await setDefaultPaymentMethod(paymentMethodId);
      if (!applied.ok) {
        setError("Card was saved but could not be set as default.");
        return;
      }
      onDone();
    } catch (err) {
      setError(publicErrorMessage(err, "Card could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <PaymentElement />
      {error ? <p className="text-sm text-error-text">{error}</p> : null}
      <Button type="submit" disabled={!stripe || busy}>
        {busy ? "Saving…" : "Save card"}
      </Button>
    </form>
  );
}

export function PaymentMethodForm({
  paymentMethod,
}: {
  paymentMethod: Subscription["paymentMethod"];
}) {
  const router = useRouter();
  const [setup, setSetup] = useState<{
    clientSecret: string;
    publishableKey: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await createSetupIntent();
      if (!outcome.ok || !outcome.result?.clientSecret || !outcome.result.publishableKey?.startsWith("pk_")) {
        setError("Could not start card collection.");
        return;
      }
      setSetup({
        clientSecret: outcome.result.clientSecret,
        publishableKey: outcome.result.publishableKey,
      });
    } catch (err) {
      setError(publicErrorMessage(err, "Could not start card collection."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Payment method</h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        Card on file for renewals. Details go to Stripe only — Markii never sees the number.
      </p>

      {paymentMethod ? (
        <p className="mt-4 text-sm text-foreground">
          <span className="capitalize">{paymentMethod.brand}</span> ending in{" "}
          <span className="tabular-nums">{paymentMethod.last4}</span>, expires{" "}
          <span className="tabular-nums">
            {paymentMethod.expMonth}/{paymentMethod.expYear}
          </span>
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted">No default card on file.</p>
      )}

      {!setup ? (
        <Button type="button" className="mt-4" disabled={busy} onClick={() => void start()}>
          {busy ? "Preparing…" : paymentMethod ? "Replace card" : "Add card"}
        </Button>
      ) : (
        <div className="mt-4">
          <Elements
            stripe={stripePromiseFor(setup.publishableKey)}
            options={{ clientSecret: setup.clientSecret }}
          >
            <CardForm
              onDone={() => {
                setSetup(null);
                setMessage("Card saved and set as default.");
                router.refresh();
              }}
            />
          </Elements>
        </div>
      )}

      {error ? <p className="mt-3 text-sm text-error-text">{error}</p> : null}
      {message ? <p className="mt-3 text-sm text-success-text">{message}</p> : null}
    </section>
  );
}
