import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorefrontCart } from "@/lib/api/storefront-cart";

/**
 * What the storefront cart shows a shopper about money (§18.6).
 *
 * **Every case here is a bug that shipped**, found by a person looking at the
 * rendered page rather than by any suite:
 *
 * - `Tax ({cart.tax.state})` printed a raw internal enum to customers, so a
 *   store awaiting configuration showed **"Tax (not_configured)"**.
 * - A tax-inclusive store showed **"Tax $0.00"** while genuinely charging tax —
 *   `amountMinor` is zero by design there and the real figure lives only in the
 *   breakdown, which was being discarded before it reached the page.
 * - The blocked-checkout CTA always read "Complete shipping to continue", even
 *   when shipping was fine and *tax* was the blocker, sending the shopper back
 *   to a form that was already correct.
 *
 * None of the three is a type error and none is reachable from an integration
 * test, because this island renders in a browser. That is the gap this file
 * closes.
 *
 * **The payloads below were captured from the live API**, not invented, so they
 * cannot drift into shapes the server never produces — the failure mode that
 * put `"not_applicable"` into `MoneyComponent["state"]` for months.
 */

const { getCart } = vi.hoisted(() => ({ getCart: vi.fn() }));

/**
 * The network is the only thing stubbed. The component's own logic — which
 * label, which figure, which rows — is exactly what is under test, so mocking
 * any more of it would be testing the mock.
 */
vi.mock("@/lib/api/storefront-cart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/storefront-cart")>()),
  getCart,
  readCartToken: () => "test-cart-token",
  writeCartToken: vi.fn(),
  clearCartToken: vi.fn(),
}));

/**
 * Stripe's browser SDK injects a `<script src="js.stripe.com/…">` at import
 * time, which a DOM with script loading disabled reports as an unhandled
 * `DOMException`. It does not fail anything, but an alarming stack trace on
 * every run is how real errors stop being read. None of these cases open a card
 * payment, so the loader is stubbed rather than the tests being narrowed.
 */
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(async () => null) }));

const { CartCheckout } = await import("./cart-checkout");

/** A cart of 2 × $50.00 with $8.00 shipping — the basket used for every case. */
function cartWith(tax: StorefrontCart["tax"], totalMinor: number): StorefrontCart {
  return {
    token: "test-cart-token",
    storeId: 1,
    status: "open",
    customerId: null,
    email: null,
    discountCodes: [],
    shippingAddress: { country: "US", line1: "1 Test St", city: "Denver", province: "CO" },
    shippingRateId: 1,
    currency: "USD",
    lines: [
      {
        id: 1,
        productId: 1,
        variantId: 1,
        title: "Taxed Thing — Default",
        quantity: 2,
        unitPriceMinor: 5000,
        lineTotalMinor: 10000,
        requiresShipping: true,
      },
    ],
    subtotalMinor: 10000,
    discount: { amountMinor: 0, state: "none" },
    tax,
    shipping: { amountMinor: 800, state: "calculated", note: "Standard (US)" },
    shippingRates: [{ id: 1, name: "Standard", priceMinor: 800 }],
    shippingState: "quoted",
    discounts: [],
    rejectedCodes: [],
    totalMinor,
    totalState: tax.state === "not_configured" ? "provisional" : "final",
    issues: [],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as StorefrontCart;
}

function renderCart(cart: StorefrontCart) {
  getCart.mockResolvedValue(cart);
  render(
    <CartCheckout homeHref="/" accountHref="/account" rails={{ stripe: false, x402: true }} />,
  );
  return waitFor(() => expect(screen.getByText("Subtotal")).toBeTruthy());
}

beforeEach(() => getCart.mockReset());
afterEach(() => cleanup());

describe("storefront cart totals", () => {
  it("never shows a shopper a raw state enum", async () => {
    // The exact string a customer saw before this was fixed.
    await renderCart(
      cartWith(
        {
          amountMinor: 0,
          state: "not_configured",
          note: "Stripe Tax is selected but this store is not connected to Stripe.",
          breakdown: [],
        },
        10800,
      ),
    );
    expect(document.body.textContent).not.toMatch(/not_configured/);
    expect(document.body.textContent).not.toMatch(/\bcalculated\b/);
  });

  it("gives the reason when tax cannot be calculated, because that refuses the sale", async () => {
    // A shopper who is not told why meets a checkout that will not proceed and
    // has no way to find out what is wrong.
    const note = "Stripe Tax is selected but this store is not connected to Stripe.";
    await renderCart(
      cartWith({ amountMinor: 0, state: "not_configured", note, breakdown: [] }, 10800),
    );
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("names tax as the blocker rather than sending the shopper back to shipping", async () => {
    /**
     * `totalState` goes provisional for shipping *or* tax, and the CTA used to
     * blame shipping for both. On a store whose tax provider cannot answer that
     * is a dead end: the address is already correct and nothing the shopper does
     * changes it.
     */
    await renderCart(
      cartWith({ amountMinor: 0, state: "not_configured", note: "…", breakdown: [] }, 10800),
    );
    expect(document.body.textContent).toMatch(/checkout is on hold/i);
    expect(document.body.textContent).not.toMatch(/Complete shipping to continue/);
  });

  it("still blames shipping when shipping really is the blocker", async () => {
    // The fix must not overcorrect: an unselected rate is the shopper's to fix
    // and telling them so is right.
    const cart = cartWith({ amountMinor: 0, state: "none", breakdown: [] }, 10000);
    cart.shipping = { amountMinor: 0, state: "not_configured", note: "Select a shipping rate." };
    cart.totalState = "provisional";
    await renderCart(cart);
    expect(document.body.textContent).toMatch(/Complete shipping to continue/);
  });

  it("itemises tax by jurisdiction", async () => {
    await renderCart(
      cartWith(
        {
          amountMinor: 945,
          state: "calculated",
          breakdown: [{ name: "Colorado sales tax", rateBps: 875, amountMinor: 945 }],
        },
        11745,
      ),
    );
    // The rate belongs on the receipt, not just the total — several
    // jurisdictions require the itemisation.
    expect(screen.getByText("Colorado sales tax (8.75%)")).toBeTruthy();
  });

  it("shows the tax inside a tax-inclusive price instead of a bare zero", async () => {
    /**
     * **The bug that motivated all of this.** `amountMinor` is zero by design on
     * a tax-inclusive store, so rendering it alone told the shopper no tax was
     * charged when $8.69 was — sitting inside the price they could already see.
     */
    await renderCart(
      cartWith(
        {
          amountMinor: 0,
          state: "calculated",
          note: "Includes Colorado sales tax of 869 (prices are tax-inclusive).",
          breakdown: [{ name: "Colorado sales tax", rateBps: 875, amountMinor: 869 }],
        },
        10800,
      ),
    );
    expect(screen.getByText("Tax (included)")).toBeTruthy();
    expect(screen.getAllByText("$8.69").length).toBeGreaterThan(0);
    // And it is **not** added on top: the total is the subtotal plus shipping.
    expect(screen.getByText("$108.00")).toBeTruthy();
  });

  it("adds tax on top when the store prices exclusive of it", async () => {
    // The opposite arrangement, to pin that "included" is not shown for both.
    await renderCart(
      cartWith(
        {
          amountMinor: 945,
          state: "calculated",
          breakdown: [{ name: "Colorado sales tax", rateBps: 875, amountMinor: 945 }],
        },
        11745,
      ),
    );
    expect(screen.getByText("Tax")).toBeTruthy();
    expect(screen.queryByText("Tax (included)")).toBeNull();
    expect(screen.getByText("$117.45")).toBeTruthy();
  });
});
