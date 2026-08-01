import { describe, expect, it } from "vitest";
import { computeRefund, financialStatusAfter, type RefundContext } from "./refunds";
import type { OrderLine } from "../db";

/**
 * Refund arithmetic (§18.7) — pure, no database.
 *
 * The rule these exist to protect is D36: the meter sees **net sales**
 * (`subtotal − discounts`), never the amount returned. Tax belongs to a
 * government and shipping to a carrier; crediting either against the threshold
 * would hand a merchant meter room they never earned, worst to whoever ships
 * the most.
 */

const line = (over: Partial<OrderLine> & { id: number }): OrderLine => ({
  orderId: 1,
  productId: 10,
  variantId: null,
  title: "Mug",
  variantTitle: null,
  sku: null,
  quantity: 3,
  unitPriceMinor: 1000,
  subtotalMinor: 3000,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 3000,
  addOns: [],
  quantityRefunded: 0,
  quantityFulfilled: 0,
  locationId: null,
  createdAt: new Date(),
  ...over,
});

function ctx(over: Partial<RefundContext> = {}): RefundContext {
  const lines = over.lines ?? [line({ id: 1 })];
  const subtotal = lines.reduce((s, l) => s + l.subtotalMinor, 0);
  const discount = lines.reduce((s, l) => s + l.discountMinor, 0);
  const tax = lines.reduce((s, l) => s + l.taxMinor, 0);
  const shipping = over.order?.shippingMinor ?? 0;
  return {
    lines,
    shippingAlreadyRefundedMinor: 0,
    ...over,
    order: {
      amountCents: subtotal - discount + tax + shipping,
      refundedMinor: 0,
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxMinor: tax,
      shippingMinor: shipping,
      ...over.order,
    },
  };
}

describe("computeRefund — the net-sales base (D36)", () => {
  it("excludes tax and shipping from what reaches the meter", () => {
    const c = ctx({
      lines: [line({ id: 1, quantity: 1, subtotalMinor: 5000, taxMinor: 400, totalMinor: 5400 })],
      order: { shippingMinor: 500 } as RefundContext["order"],
    });
    const r = computeRefund(c, { lines: [{ orderLineId: 1, quantity: 1 }], shippingMinor: 500 }, {
      restock: true,
    });

    // The shopper gets goods + tax + postage back...
    expect(r.amountMinor).toBe(5900);
    // ...but only the goods were ever revenue.
    expect(r.netSalesMinor).toBe(5000);
  });

  it("subtracts the discount from the metered base as the sale did", () => {
    const c = ctx({
      lines: [line({ id: 1, quantity: 1, subtotalMinor: 5000, discountMinor: 500, totalMinor: 4500 })],
    });
    const r = computeRefund(c, { lines: [{ orderLineId: 1, quantity: 1 }] }, { restock: true });
    expect(r.amountMinor).toBe(4500);
    expect(r.netSalesMinor).toBe(4500);
  });

  it("meters nothing for a shipping-only refund", () => {
    const c = ctx({ order: { shippingMinor: 700 } as RefundContext["order"] });
    const r = computeRefund(c, { shippingMinor: 700 }, { restock: true });
    expect(r.amountMinor).toBe(700);
    expect(r.netSalesMinor).toBe(0);
    expect(r.lines).toHaveLength(0);
  });
});

describe("computeRefund — partial refunds", () => {
  it("takes a proportional slice of the line's allocated tax and discount", () => {
    const c = ctx({
      lines: [
        line({ id: 1, quantity: 3, subtotalMinor: 3000, discountMinor: 300, taxMinor: 270 }),
      ],
    });
    const r = computeRefund(c, { lines: [{ orderLineId: 1, quantity: 2 }] }, { restock: true });
    expect(r.subtotalMinor).toBe(2000);
    expect(r.discountMinor).toBe(200);
    expect(r.taxMinor).toBe(180);
    expect(r.amountMinor).toBe(1980);
    expect(r.netSalesMinor).toBe(1800);
  });

  it("refunding every unit in steps returns exactly the line total", () => {
    const base = line({ id: 1, quantity: 3, subtotalMinor: 1000, taxMinor: 10 });
    let already = 0;
    let returned = 0;
    for (const step of [1, 1, 1]) {
      const r = computeRefund(
        ctx({ lines: [{ ...base, quantityRefunded: already }] }),
        { lines: [{ orderLineId: 1, quantity: step }] },
        { restock: true },
      );
      returned += r.amountMinor;
      already += step;
    }
    expect(returned).toBe(1010);
  });
});

describe("computeRefund — refusals", () => {
  it("refuses more units than the line has left", () => {
    const c = ctx({ lines: [line({ id: 1, quantity: 3, quantityRefunded: 2 })] });
    expect(() =>
      computeRefund(c, { lines: [{ orderLineId: 1, quantity: 2 }] }, { restock: true }),
    ).toThrow(/1 unit\(s\) left/);
  });

  it("refuses to push total refunds past what was paid", () => {
    const c = ctx({
      lines: [line({ id: 1, quantity: 1, subtotalMinor: 1000, totalMinor: 1000 })],
      order: { amountCents: 1000, refundedMinor: 900 } as RefundContext["order"],
    });
    expect(() =>
      computeRefund(c, { lines: [{ orderLineId: 1, quantity: 1 }] }, { restock: true }),
    ).toThrow(/exceed/);
  });

  it("refuses more shipping than the order charged", () => {
    const c = ctx({ order: { shippingMinor: 500 } as RefundContext["order"] });
    expect(() => computeRefund(c, { shippingMinor: 600 }, { restock: true })).toThrow(/shipping/);
  });

  it("counts shipping already refunded on earlier refunds", () => {
    const c = ctx({
      order: { shippingMinor: 500 } as RefundContext["order"],
      shippingAlreadyRefundedMinor: 500,
    });
    expect(() => computeRefund(c, { shippingMinor: 1 }, { restock: true })).toThrow(/shipping/);
  });

  it("refuses the same line twice in one refund", () => {
    const c = ctx({ lines: [line({ id: 1, quantity: 3 })] });
    expect(() =>
      computeRefund(
        c,
        { lines: [{ orderLineId: 1, quantity: 1 }, { orderLineId: 1, quantity: 1 }] },
        { restock: true },
      ),
    ).toThrow(/twice/);
  });

  it("refuses a line that belongs to another order", () => {
    expect(() =>
      computeRefund(ctx(), { lines: [{ orderLineId: 99, quantity: 1 }] }, { restock: true }),
    ).toThrow(/not on this order/);
  });

  it("refuses an empty refund", () => {
    expect(() => computeRefund(ctx(), {}, { restock: true })).toThrow(/at least one line/);
  });
});

describe("computeRefund — amount refunds on un-itemised orders", () => {
  const legacy = (): RefundContext => ({
    lines: [],
    shippingAlreadyRefundedMinor: 0,
    order: {
      amountCents: 2500,
      refundedMinor: 0,
      subtotalMinor: 2500,
      discountMinor: 0,
      taxMinor: 0,
      shippingMinor: 0,
    },
  });

  it("meters the whole amount, since such an order has no tax or shipping", () => {
    const r = computeRefund(legacy(), { amountMinor: 1000 }, { restock: true });
    expect(r.amountMinor).toBe(1000);
    expect(r.netSalesMinor).toBe(1000);
  });

  it("refuses an amount refund on an itemised order", () => {
    expect(() => computeRefund(ctx(), { amountMinor: 100 }, { restock: true })).toThrow(
      /itemised/,
    );
  });

  it("refuses to mix an amount with lines", () => {
    const c = legacy();
    expect(() =>
      computeRefund(c, { amountMinor: 100, lines: [{ orderLineId: 1, quantity: 1 }] }, {
        restock: true,
      }),
    ).toThrow(/not both/);
  });

  it("refuses when the order has tax or shipping it cannot split", () => {
    const c = legacy();
    c.order.taxMinor = 200;
    expect(() => computeRefund(c, { amountMinor: 100 }, { restock: true })).toThrow(/net sales/);
  });

  it("still refuses to exceed what was paid", () => {
    const c = legacy();
    c.order.refundedMinor = 2400;
    expect(() => computeRefund(c, { amountMinor: 200 }, { restock: true })).toThrow(/exceed/);
  });
});

describe("financialStatusAfter", () => {
  it("reports paid, partial, and full", () => {
    expect(financialStatusAfter(1000, 0)).toBe("paid");
    expect(financialStatusAfter(1000, 400)).toBe("partially_refunded");
    expect(financialStatusAfter(1000, 1000)).toBe("refunded");
  });
});
