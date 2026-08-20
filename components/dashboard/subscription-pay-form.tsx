"use client";

import { useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { publicErrorMessage } from "@/lib/api/public-copy";
import {
  markiiStripeAppearance,
  stripePromiseFor,
} from "@/components/dashboard/stripe-browser";
import { Button } from "@/components/ui/button";

function PayForm({ onDone }: { onDone: () => void }) {
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
      const result = await stripe.confirmPayment({
        elements,
        redirect: "if_required",
      });
      if (result.error) {
        setError(result.error.message ?? "Payment failed.");
        return;
      }
      onDone();
    } catch (err) {
      setError(publicErrorMessage(err, "Payment failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <PaymentElement />
      {error ? <p className="text-sm text-error-text">{error}</p> : null}
      <Button type="submit" disabled={!stripe || busy}>
        {busy ? "Paying…" : "Pay and subscribe"}
      </Button>
    </form>
  );
}

export function SubscriptionPayForm({
  clientSecret,
  publishableKey,
  onDone,
}: {
  clientSecret: string;
  publishableKey: string;
  onDone: () => void;
}) {
  return (
    <Elements
      stripe={stripePromiseFor(publishableKey)}
      options={{ clientSecret, appearance: markiiStripeAppearance }}
    >
      <PayForm onDone={onDone} />
    </Elements>
  );
}
