"use client";

import { useMemo, useState } from "react";
import { ensureCart } from "@/lib/api/storefront-cart";
import { formatMinor } from "@/lib/api/money";
import "./cart-island.css";

export type StorefrontVariantOption = {
  name: string;
  position: number;
  values: string[];
};

export type StorefrontVariant = {
  id: number;
  title: string;
  optionValues: Record<string, string>;
  priceMinor: number;
  available: number;
};

/**
 * Sanctioned storefront island: variant choice + add to cart.
 * Product chrome stays SSR; only this interactive strip is client-side.
 */
export function AddToCart({
  productId,
  currency,
  basePriceMinor,
  options,
  variants,
  cartHref,
  locked = false,
}: {
  productId: number;
  currency: string;
  basePriceMinor: number;
  options: StorefrontVariantOption[];
  variants: StorefrontVariant[];
  cartHref: string;
  locked?: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const opt of options) {
      if (opt.values[0]) init[opt.name] = opt.values[0];
    }
    return init;
  });
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const variant = useMemo(() => {
    if (variants.length === 0) return null;
    return (
      variants.find((v) =>
        options.every((o) => v.optionValues[o.name] === selected[o.name]),
      ) ?? null
    );
  }, [variants, options, selected]);

  const priceMinor = variant?.priceMinor ?? basePriceMinor;
  const available = variant ? variant.available : null;
  const needsVariant = variants.length > 0;
  const canBuy =
    !locked &&
    (!needsVariant || variant != null) &&
    (available == null || available > 0);

  async function onAdd() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await ensureCart({
        productId,
        variantId: variant?.id ?? null,
        quantity: qty,
      });
      setMessage("Added to cart.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add to cart.");
    } finally {
      setBusy(false);
    }
  }

  if (locked) return null;

  return (
    <div className="sf-cart-island">
      {options.map((opt) => (
        <div key={opt.name} className="sf-field">
          <label htmlFor={`opt-${opt.name}`}>{opt.name}</label>
          <select
            id={`opt-${opt.name}`}
            value={selected[opt.name] ?? ""}
            onChange={(e) =>
              setSelected((prev) => ({ ...prev, [opt.name]: e.target.value }))
            }
          >
            {opt.values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      ))}

      <p className="sf-price">{formatMinor(priceMinor, currency)}</p>
      {available != null ? (
        <p className="sf-muted">
          {available > 0 ? `${available} in stock` : "Out of stock"}
        </p>
      ) : null}

      <div className="sf-field">
        <label htmlFor="qty">Quantity</label>
        <input
          id="qty"
          type="number"
          min={1}
          max={999}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
        />
      </div>

      <div className="sf-actions">
        <button
          type="button"
          className="sf-btn"
          disabled={!canBuy || busy}
          onClick={() => void onAdd()}
        >
          {busy ? "Adding…" : "Add to cart"}
        </button>
        <a className="sf-link" href={cartHref}>
          View cart
        </a>
      </div>

      {error ? <p className="sf-error">{error}</p> : null}
      {message ? (
        <p className="sf-ok">
          {message}{" "}
          <a href={cartHref}>Checkout</a>
        </p>
      ) : null}
      {needsVariant && !variant ? (
        <p className="sf-muted">That combination is not available.</p>
      ) : null}
    </div>
  );
}
