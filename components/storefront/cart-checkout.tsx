"use client";

import { useEffect, useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { formatMinor } from "@/lib/api/money";
import { ApiClientError } from "@/lib/api/types";
import {
  applyDiscount,
  clearCartToken,
  completeCheckoutSession,
  createCheckoutSession,
  createSubscriptionCheckout,
  ensureCart,
  getCart,
  isSubscriptionCheckoutRequired,
  patchCart,
  quoteShippingRates,
  readCartToken,
  removeDiscount,
  type StorefrontCart,
} from "@/lib/api/storefront-cart";
import "./cart-island.css";

const stripeCache = new Map<string, Promise<Stripe | null>>();

function stripeFor(publishableKey: string, accountId?: string) {
  const cacheKey = `${publishableKey}:${accountId ?? ""}`;
  let cached = stripeCache.get(cacheKey);
  if (!cached) {
    cached = loadStripe(
      publishableKey,
      accountId ? { stripeAccount: accountId } : undefined,
    );
    stripeCache.set(cacheKey, cached);
  }
  return cached;
}

function StripePay({
  mode,
  sessionId,
  onOrderDone,
  onSubscriptionDone,
}: {
  mode: "order" | "subscription";
  sessionId: string | null;
  onOrderDone: (orderId: number) => void;
  onSubscriptionDone: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay(e: React.FormEvent) {
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
      if (mode === "subscription") {
        // Membership is granted by invoice.paid — never claim access here.
        clearCartToken();
        onSubscriptionDone();
        return;
      }
      const pi =
        typeof result.paymentIntent?.id === "string"
          ? result.paymentIntent.id
          : null;
      if (!pi || !sessionId) {
        setError("Stripe did not return a payment id.");
        return;
      }
      const done = await completeCheckoutSession(sessionId, {
        paymentReference: pi,
      });
      clearCartToken();
      onOrderDone(done.orderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void pay(e)} className="sf-checkout-pay">
      <PaymentElement />
      {error ? <p className="sf-error">{error}</p> : null}
      <button type="submit" className="sf-btn" disabled={!stripe || busy}>
        {busy ? "Paying…" : mode === "subscription" ? "Subscribe" : "Pay now"}
      </button>
    </form>
  );
}

export function CartCheckout({
  homeHref,
  accountHref,
  rails,
}: {
  homeHref: string;
  accountHref: string;
  rails: { stripe: boolean; x402: boolean };
}) {
  const [cart, setCart] = useState<StorefrontCart | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [country, setCountry] = useState("US");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [postal, setPostal] = useState("");
  const [rail, setRail] = useState<"stripe" | "x402">(
    rails.stripe ? "stripe" : "x402",
  );
  const [stripePay, setStripePay] = useState<{
    mode: "order" | "subscription";
    sessionId: string | null;
    clientSecret: string;
    publishableKey: string;
    accountId?: string;
    note?: string;
  } | null>(null);
  const [x402Pay, setX402Pay] = useState<{
    sessionId: string;
    payTo?: string;
    totalMinor: number;
    currency: string;
  } | null>(null);
  const [txHash, setTxHash] = useState("");
  const [orderId, setOrderId] = useState<number | null>(null);
  const [subscriptionStarted, setSubscriptionStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = readCartToken();
      if (!token) {
        if (!cancelled) {
          setCart(null);
          setLoading(false);
        }
        return;
      }
      try {
        const next = await getCart(token);
        if (!cancelled) {
          setCart(next);
          if (next.email) setEmail(next.email);
        }
      } catch {
        if (!cancelled) {
          clearCartToken();
          setCart(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(fn: () => Promise<StorefrontCart>) {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setCart(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="sf-muted">Loading cart…</p>;
  }

  if (subscriptionStarted) {
    return (
      <div className="sf-cart-island">
        <h1 className="sf-title">Subscription started</h1>
        <p>
          Your payment is confirming. Membership access begins once the first invoice
          is paid — it may take a moment.
        </p>
        <p className="sf-muted">
          Manage renewals from your{" "}
          <a href={accountHref}>account</a>.
        </p>
        <a className="sf-btn" href={homeHref}>
          Back to store
        </a>
      </div>
    );
  }

  if (orderId != null) {
    return (
      <div className="sf-cart-island">
        <h1 className="sf-title">Thank you</h1>
        <p>Order #{orderId} is confirmed.</p>
        <a className="sf-btn" href={homeHref}>
          Back to store
        </a>
      </div>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <div className="sf-cart-island">
        <h1 className="sf-title">Your cart</h1>
        <p className="sf-muted">Your cart is empty.</p>
        <a className="sf-btn" href={homeHref}>
          Continue shopping
        </a>
      </div>
    );
  }

  const availableRails = (
    [
      rails.stripe ? ("stripe" as const) : null,
      rails.x402 ? ("x402" as const) : null,
    ] as const
  ).filter(Boolean) as ("stripe" | "x402")[];

  return (
    <div className="sf-cart-island sf-cart-layout">
      <div>
        <h1 className="sf-title">Your cart</h1>
        <ul className="sf-list">
          {cart.lines.map((line) => (
            <li key={line.id}>
              <span>
                {line.title} × {line.quantity}
              </span>
              <span className="sf-price">
                {formatMinor(line.lineTotalMinor, cart.currency)}
              </span>
              <button
                type="button"
                className="sf-link"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    patchCart(cart.token, {
                      setQuantity: { lineId: line.id, quantity: 0 },
                    }),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <dl className="sf-totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatMinor(cart.subtotalMinor, cart.currency)}</dd>
          </div>
          <div>
            <dt>Discount</dt>
            <dd>{formatMinor(cart.discount.amountMinor, cart.currency)}</dd>
          </div>
          <div>
            <dt>Shipping ({cart.shipping.state})</dt>
            <dd>{formatMinor(cart.shipping.amountMinor, cart.currency)}</dd>
          </div>
          <div>
            <dt>Tax ({cart.tax.state})</dt>
            <dd>{formatMinor(cart.tax.amountMinor, cart.currency)}</dd>
          </div>
          <div className="sf-total">
            <dt>Total</dt>
            <dd>
              {formatMinor(cart.totalMinor, cart.currency)}
              {cart.totalState !== "final" ? (
                <span className="sf-muted"> · provisional</span>
              ) : null}
            </dd>
          </div>
        </dl>

        {cart.issues.length > 0 ? (
          <ul className="sf-error">
            {cart.issues.map((i) => (
              <li key={`${i.code}-${i.reason}`}>{i.reason}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="sf-checkout">
        <h2>Checkout</h2>

        <label className="sf-field">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <fieldset className="sf-fieldset">
          <legend>Shipping address</legend>
          <label className="sf-field">
            Country
            <input
              value={country}
              maxLength={2}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </label>
          <label className="sf-field">
            Address
            <input value={line1} onChange={(e) => setLine1(e.target.value)} />
          </label>
          <label className="sf-field">
            City
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="sf-field">
            Postal code
            <input value={postal} onChange={(e) => setPostal(e.target.value)} />
          </label>
          <button
            type="button"
            className="sf-btn"
            disabled={busy || !line1 || !city || !postal}
            onClick={() =>
              void run(async () => {
                const address = {
                  country,
                  line1,
                  city,
                  postalCode: postal,
                };
                await patchCart(cart.token, {
                  email: email || undefined,
                  shippingAddress: address,
                });
                const quoted = await quoteShippingRates(cart.token, {
                  address,
                  save: true,
                });
                if (quoted.rates[0] && quoted.selectedRateId == null) {
                  return patchCart(cart.token, {
                    shippingRateId: quoted.rates[0].id,
                  });
                }
                return getCart(cart.token);
              })
            }
          >
            Update shipping
          </button>
        </fieldset>

        {cart.shippingRates.length > 0 ? (
          <label className="sf-field">
            Shipping rate
            <select
              value={cart.shippingRateId ?? ""}
              onChange={(e) =>
                void run(() =>
                  patchCart(cart.token, {
                    shippingRateId: Number(e.target.value),
                  }),
                )
              }
            >
              {cart.shippingRates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} — {formatMinor(r.priceMinor, cart.currency)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="sf-field-row">
          <input
            placeholder="Discount code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="button"
            className="sf-btn"
            disabled={busy || !code.trim()}
            onClick={() =>
              void run(() => applyDiscount(cart.token, code.trim()))
            }
          >
            Apply
          </button>
        </div>
        {cart.discountCodes.map((c) => (
          <button
            key={c}
            type="button"
            className="sf-link"
            disabled={busy}
            onClick={() => void run(() => removeDiscount(cart.token, c))}
          >
            Remove {c}
          </button>
        ))}

        {availableRails.length > 1 ? (
          <fieldset className="sf-fieldset">
            <legend>Payment</legend>
            {availableRails.map((r) => (
              <label key={r} className="sf-radio">
                <input
                  type="radio"
                  name="rail"
                  checked={rail === r}
                  onChange={() => setRail(r)}
                />
                {r === "stripe" ? "Card (Stripe)" : "USDC (x402)"}
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="sf-muted">
            Paying with {availableRails[0] === "stripe" ? "card" : "USDC (x402)"}
          </p>
        )}

        {!stripePay && !x402Pay ? (
          <button
            type="button"
            className="sf-btn"
            disabled={
              busy ||
              !email ||
              cart.totalState !== "final" ||
              cart.issues.length > 0 ||
              availableRails.length === 0
            }
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  await ensureCart();
                  await patchCart(cart.token, { email });

                  let session;
                  try {
                    session = await createCheckoutSession({
                      cartToken: cart.token,
                      rail,
                      email,
                    });
                  } catch (err) {
                    if (isSubscriptionCheckoutRequired(err)) {
                      if (!rails.stripe) {
                        throw new Error(
                          "Memberships renew by card. Enable Stripe on this store to continue.",
                        );
                      }
                      const sub = await createSubscriptionCheckout({
                        cartToken: cart.token,
                        email,
                      });
                      setStripePay({
                        mode: "subscription",
                        sessionId: null,
                        clientSecret: sub.clientSecret,
                        publishableKey: sub.publishableKey,
                        accountId: sub.stripeAccount,
                        note: sub.note,
                      });
                      setRail("stripe");
                      return;
                    }
                    if (
                      err instanceof ApiClientError &&
                      err.message.toLowerCase().includes("sign in")
                    ) {
                      setError(
                        `${err.message} Open your account to sign in, then return here.`,
                      );
                      return;
                    }
                    throw err;
                  }

                  if (rail === "stripe") {
                    if (
                      !session.payment.clientSecret ||
                      !session.payment.publishableKey
                    ) {
                      throw new Error("Card checkout is not ready for this store.");
                    }
                    setStripePay({
                      mode: "order",
                      sessionId: session.id,
                      clientSecret: session.payment.clientSecret,
                      publishableKey: session.payment.publishableKey,
                      accountId: session.payment.accountId,
                    });
                  } else {
                    setX402Pay({
                      sessionId: session.id,
                      payTo: session.payment.payTo,
                      totalMinor: session.totalMinor,
                      currency: session.currency,
                    });
                  }
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Checkout failed.",
                  );
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {cart.totalState !== "final"
              ? "Complete shipping to continue"
              : "Continue to payment"}
          </button>
        ) : null}

        {stripePay ? (
          <div className="sf-checkout-pay">
            {stripePay.mode === "subscription" && stripePay.note ? (
              <p className="sf-muted">{stripePay.note}</p>
            ) : null}
            <Elements
              stripe={stripeFor(stripePay.publishableKey, stripePay.accountId)}
              options={{ clientSecret: stripePay.clientSecret }}
            >
              <StripePay
                mode={stripePay.mode}
                sessionId={stripePay.sessionId}
                onOrderDone={(id) => setOrderId(id)}
                onSubscriptionDone={() => setSubscriptionStarted(true)}
              />
            </Elements>
            {stripePay.mode === "subscription" ? (
              <p className="sf-muted">
                Need an account?{" "}
                <a href={accountHref}>Sign in or create one</a> before
                subscribing.
              </p>
            ) : null}
          </div>
        ) : null}

        {x402Pay ? (
          <div className="sf-checkout-pay">
            <p className="sf-muted">
              Send {formatMinor(x402Pay.totalMinor, x402Pay.currency)} USDC
              {x402Pay.payTo ? ` to ${x402Pay.payTo}` : ""}, then paste the
              transaction hash.
            </p>
            <label className="sf-field">
              Transaction hash
              <input
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="sf-btn"
              disabled={busy || !txHash.trim()}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const done = await completeCheckoutSession(x402Pay.sessionId, {
                      paymentReference: txHash.trim(),
                    });
                    clearCartToken();
                    setOrderId(done.orderId);
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : "Could not complete.",
                    );
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              Confirm payment
            </button>
          </div>
        ) : null}

        {error ? <p className="sf-error">{error}</p> : null}
      </div>
    </div>
  );
}
