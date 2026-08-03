import { describe, expect, it } from "vitest";
import { digitalDelivery } from "./delivery";
import {
  cancellationNotice,
  orderConfirmation,
  refundNotice,
  shippingNotice,
  type OrderMailContext,
} from "./orders";

/**
 * Transactional mail templates.
 *
 * These are the only part of Markii a shopper reads, so the tests are about
 * **what the email claims** rather than how it looks: that money is formatted
 * from the currency's own exponent (D31), that merchant-controlled strings
 * cannot break out into markup, and that a refund nobody has actually processed
 * is never described as one.
 */

const base: OrderMailContext = {
  storeName: "Acme Supply",
  orderId: 1042,
  currency: "USD",
  lines: [
    { title: "Field Notebook", variantTitle: "Grid", sku: "FN-01", quantity: 2, totalMinor: 3000 },
    { title: "Pencil", variantTitle: null, sku: null, quantity: 1, totalMinor: 250 },
  ],
  subtotalMinor: 3250,
  discountMinor: 0,
  taxMinor: 0,
  shippingMinor: 0,
  totalMinor: 3250,
  orderUrl: null,
  supportEmail: null,
};

describe("orderConfirmation", () => {
  it("formats money from the currency, never as raw minor units", () => {
    const mail = orderConfirmation(base);
    // The bug this replaces printed `3250 USD` into a customer's receipt.
    expect(mail.html).toContain("$32.50");
    expect(mail.text).toContain("$32.50");
    expect(mail.text).not.toMatch(/\b3250\b/);
  });

  it("uses the currency's own exponent for a zero-decimal currency", () => {
    // JPY has no minor units. A hardcoded /100 renders ¥3,250 as ¥32.50 — the
    // customer is quoted 1/100th of the price (D31).
    const mail = orderConfirmation({ ...base, currency: "JPY", subtotalMinor: 3250, totalMinor: 3250 });
    expect(mail.text).toContain("¥3,250");
    expect(mail.text).not.toContain("32.50");
  });

  it("escapes merchant-controlled titles instead of emitting them as markup", () => {
    const mail = orderConfirmation({
      ...base,
      lines: [
        {
          title: '<script>alert(1)</script> & "quotes"',
          variantTitle: null,
          sku: null,
          quantity: 1,
          totalMinor: 100,
        },
      ],
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("&amp;");
  });

  it("omits zero discount, tax and shipping rather than claiming them", () => {
    // An explicit "Tax $0.00" reads as a statement that tax was assessed and
    // came to nothing, which on an unconfigured store is not true.
    const mail = orderConfirmation(base);
    expect(mail.text).not.toContain("Tax:");
    expect(mail.text).not.toContain("Shipping:");
    expect(mail.text).not.toContain("Discount:");
  });

  it("shows discount, tax and shipping when they are real", () => {
    const mail = orderConfirmation({
      ...base,
      discountMinor: 500,
      taxMinor: 260,
      shippingMinor: 495,
      totalMinor: 3505,
    });
    expect(mail.text).toContain("Discount: -$5.00");
    expect(mail.text).toContain("Tax: $2.60");
    expect(mail.text).toContain("Shipping: $4.95");
    expect(mail.text).toContain("Total: $35.05");
  });

  it("renders the stored total, not a re-derived one", () => {
    // If the parts and the total ever disagree, the customer's receipt must
    // show what was charged.
    const mail = orderConfirmation({ ...base, totalMinor: 9999 });
    expect(mail.text).toContain("Total: $99.99");
  });

  it("always produces both a text and an html part", () => {
    // text/plain is what screen readers and agents parsing a receipt read.
    const mail = orderConfirmation(base);
    expect(mail.text.length).toBeGreaterThan(0);
    expect(mail.html.length).toBeGreaterThan(0);
    expect(mail.subject).toContain("1042");
  });
});

describe("shippingNotice", () => {
  it("says only part of the order shipped when that is true", () => {
    const mail = shippingNotice({
      order: base,
      carrier: "Royal Mail",
      trackingNumber: "AB123",
      trackingUrl: null,
      shipped: [{ title: "Field Notebook", quantity: 1 }],
      partial: true,
    });
    expect(mail.text).toContain("Some of order #1042 has shipped");
    expect(mail.text).toContain("The rest will follow separately");
  });

  it("does not hedge when the whole order shipped", () => {
    const mail = shippingNotice({
      order: base,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shipped: [{ title: "Field Notebook", quantity: 2 }],
      partial: false,
    });
    expect(mail.text).not.toContain("Some of order");
    expect(mail.text).toContain("has shipped");
  });

  it("includes tracking details only when they exist", () => {
    const mail = shippingNotice({
      order: base,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shipped: [{ title: "Pencil", quantity: 1 }],
      partial: false,
    });
    expect(mail.text).not.toContain("Carrier:");
    expect(mail.text).not.toContain("Tracking:");
  });
});

describe("refundNotice", () => {
  it("does not promise a card reversal for a refund the merchant sent themselves", () => {
    // The load-bearing assertion in this file. Every refund today is `manual`:
    // Markii never held the money and x402 has no reversal at all.
    const mail = refundNotice({
      order: base,
      refundedMinor: 3000,
      lines: [{ title: "Field Notebook", quantity: 2 }],
      settled: false,
      rail: "manual",
    });
    expect(mail.text).not.toContain("original payment method");
    expect(mail.text).toContain("sent by the store directly");
    expect(mail.text).toContain("$30.00");
  });

  it("describes a processor refund as reaching the original payment method", () => {
    const mail = refundNotice({
      order: base,
      refundedMinor: 3000,
      lines: [],
      settled: true,
      rail: "stripe",
    });
    expect(mail.text).toContain("original payment method");
  });

  it("puts the amount in the subject, so it is legible without opening", () => {
    const mail = refundNotice({
      order: base,
      refundedMinor: 1250,
      lines: [],
      settled: false,
      rail: "manual",
    });
    expect(mail.subject).toContain("$12.50");
  });
});

describe("cancellationNotice", () => {
  it("says the customer was not charged when nothing was refunded", () => {
    const mail = cancellationNotice({ order: base, reason: "Out of stock", refundedMinor: 0 });
    expect(mail.text).toContain("You have not been charged");
    expect(mail.text).toContain("Out of stock");
  });

  it("reports a refund when one exists rather than claiming no charge", () => {
    const mail = cancellationNotice({ order: base, reason: "Duplicate", refundedMinor: 3250 });
    expect(mail.text).not.toContain("You have not been charged");
    expect(mail.text).toContain("$32.50");
  });
});

describe("digitalDelivery", () => {
  const item = {
    name: "Preset Pack.zip",
    url: "https://acme.markii.shop/download/abc123token",
    downloadLimit: 3,
    expiresOn: "September 1, 2026",
    sizeLabel: "12 MB",
  };

  it("carries the full download URL in the text part", () => {
    // The link is the entitlement. A shopper whose client blocks the styled
    // version still has to be able to copy it.
    const mail = digitalDelivery({
      storeName: "Acme Supply",
      orderId: 1042,
      items: [item],
      licenceKeys: [],
    });
    expect(mail.text).toContain("https://acme.markii.shop/download/abc123token");
  });

  it("states the download limit and expiry, which are the terms being imposed", () => {
    const mail = digitalDelivery({
      storeName: "Acme Supply",
      orderId: 1042,
      items: [item],
      licenceKeys: [],
    });
    expect(mail.text).toContain("3 downloads");
    expect(mail.text).toContain("available until September 1, 2026");
  });

  it("says unlimited rather than omitting the limit line", () => {
    const mail = digitalDelivery({
      storeName: "Acme Supply",
      orderId: 1042,
      items: [{ ...item, downloadLimit: null, expiresOn: null }],
      licenceKeys: [],
    });
    expect(mail.text).toContain("Unlimited downloads");
  });

  it("lists licence keys with the product they belong to", () => {
    const mail = digitalDelivery({
      storeName: "Acme Supply",
      orderId: 1042,
      items: [item],
      licenceKeys: [{ key: "AAAA-BBBB", productName: "Preset Pack" }],
    });
    expect(mail.text).toContain("Preset Pack: AAAA-BBBB");
    expect(mail.html).toContain("AAAA-BBBB");
  });

  it("uses singular wording for a single download", () => {
    const one = digitalDelivery({ storeName: "S", orderId: 1, items: [item], licenceKeys: [] });
    const two = digitalDelivery({
      storeName: "S",
      orderId: 1,
      items: [item, { ...item, name: "Second.zip" }],
      licenceKeys: [],
    });
    expect(one.subject).toContain("Your download is ready");
    expect(two.subject).toContain("Your downloads are ready");
  });
});
