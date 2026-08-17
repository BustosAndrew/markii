import { describe, expect, it } from "vitest";
import { abandonedCart } from "./cart";

/**
 * Abandoned-cart copy (§24).
 *
 * This is the only merchant email a shopper did not ask for, so the things
 * worth pinning are the ones that make it defensible rather than the ones that
 * make it pretty.
 */
const base = {
  storeName: "Aurora Supply Co.",
  items: [
    { name: "Blue Tee", quantity: 2, unitPriceMinor: 1400 },
    { name: "Kettle — Large", quantity: 1, unitPriceMinor: 3800 },
  ],
  subtotalMinor: 6600,
  currency: "USD",
  recoverUrl: "https://aurora-supply.markii.shop/cart?recover=tok_abc",
  supportEmail: null,
};

describe("abandonedCart", () => {
  it("says why it arrived, in both parts", () => {
    /**
     * A shopper who cannot tell why they received a message treats it as spam —
     * and reports it, which is a complaint against the merchant's domain and,
     * through SES's account-wide rates, against every other merchant too.
     */
    const mail = abandonedCart(base);
    expect(mail.html).toMatch(/because you left items in your cart/i);
    expect(mail.text).toMatch(/because you left items in your cart/i);
  });

  it("promises it is the only reminder, and the sweep keeps that promise", () => {
    // `abandoned_mail_sent_at` is what makes this true rather than aspirational.
    expect(abandonedCart(base).text).toMatch(/only reminder/i);
  });

  it("carries the recovery link in the plain-text part too", () => {
    // Auth-style mail lands in clients that strip HTML far more often than
    // receipts do, and a shopper who cannot see the link cannot use it.
    expect(abandonedCart(base).text).toContain(base.recoverUrl);
  });

  it("prices the line by quantity and totals to the subtotal", () => {
    const mail = abandonedCart(base);
    // 2 × $14.00 = $28.00, not $14.00.
    expect(mail.text).toMatch(/\$28\.00/);
    expect(mail.text).toMatch(/\$38\.00/);
    expect(mail.text).toMatch(/Subtotal: \$66\.00/);
  });

  it("does not present the subtotal as a final total", () => {
    /**
     * Shipping and tax are unknown until an address is entered. Printing a
     * "total" here that checkout then contradicts is the fabricated-number rule
     * pointed at a customer.
     */
    expect(abandonedCart(base).text).toMatch(/worked out at checkout/i);
  });

  it("invents no urgency", () => {
    /**
     * Carts live 14 days. "Expiring soon", stock scarcity, or a countdown would
     * all be false — and a recovery email that lies about timing is the same
     * fabrication this codebase refuses everywhere else.
     */
    const mail = abandonedCart(base);
    for (const pattern of [/expir/i, /hurry/i, /running out/i, /last chance/i, /only \d+ left/i]) {
      expect(mail.text, `must not claim: ${pattern}`).not.toMatch(pattern);
      expect(mail.html, `must not claim: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("derives the decimal exponent from the currency (D31)", () => {
    // JPY has no minor unit; a hardcoded /100 would render this 100× wrong.
    const yen = abandonedCart({ ...base, currency: "JPY", subtotalMinor: 6600, items: [
      { name: "Blue Tee", quantity: 1, unitPriceMinor: 6600 },
    ] });
    expect(yen.text).toMatch(/6,600|6600/);
    expect(yen.text).not.toMatch(/66\.00/);
  });
});
