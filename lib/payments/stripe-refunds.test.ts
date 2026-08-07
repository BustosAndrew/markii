import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accepted, createStripeRefund, refundIdempotencyKey } from "./stripe-refunds";

/**
 * These cover the three ways a refund goes wrong with real money attached:
 * paying a shopper twice, paying them the wrong amount, and recording a refund
 * Stripe never accepted. Everything else about this module is a fetch call.
 */

const ACCOUNT = "acct_1TestMerchant";
const INTENT = "pi_3TestPaymentIntent";

/** The last request `createStripeRefund` made, decoded. */
type Captured = { url: string; headers: Record<string, string>; body: URLSearchParams };
let captured: Captured | null;

function stubStripe(response: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      captured = {
        url,
        headers: init.headers as Record<string, string>,
        body: new URLSearchParams(String(init.body)),
      };
      return new Response(JSON.stringify(response), { status });
    }),
  );
}

beforeEach(() => {
  captured = null;
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_platform");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const refundArgs = {
  accountId: ACCOUNT,
  paymentIntentId: INTENT,
  amountMinor: 4200,
  currency: "GBP",
  reason: "requested_by_customer",
  idempotencyKey: "markii_refund_1_0_4200",
  orderId: 1,
};

describe("createStripeRefund", () => {
  it("refunds on the merchant's own account, and takes nothing back for Markii", async () => {
    stubStripe({ id: "re_1", status: "succeeded", amount: 4200, currency: "gbp" });
    const result = await createStripeRefund(refundArgs);

    expect(result).toMatchObject({ ok: true, refundId: "re_1", status: "succeeded" });
    // The direct charge lives on the merchant's account, so the reversal must too.
    expect(captured?.headers["Stripe-Account"]).toBe(ACCOUNT);
    expect(captured?.headers["Idempotency-Key"]).toBe("markii_refund_1_0_4200");
    expect(captured?.body.get("payment_intent")).toBe(INTENT);

    /**
     * D4 in one assertion. Both parameters exist for platforms that took a cut
     * of the payment; Markii never does, so there is nothing to hand back — and
     * either one appearing here would contradict the public claim that
     * merchants keep their own rates.
     */
    expect(captured?.body.has("refund_application_fee")).toBe(false);
    expect(captured?.body.has("reverse_transfer")).toBe(false);
  });

  it("sends the amount unscaled, so a zero-decimal currency is not multiplied", async () => {
    stubStripe({ id: "re_2", status: "succeeded", amount: 5000, currency: "jpy" });
    await createStripeRefund({ ...refundArgs, amountMinor: 5000, currency: "JPY" });

    // ¥5000 is 5000 minor units in JPY. A `/100` here would refund ¥50 (D31).
    expect(captured?.body.get("amount")).toBe("5000");
  });

  it("always sends an explicit amount, so a partial refund cannot become a full one", async () => {
    stubStripe({ id: "re_3", status: "succeeded", amount: 100, currency: "gbp" });
    await createStripeRefund({ ...refundArgs, amountMinor: 100 });

    expect(captured?.body.get("amount")).toBe("100");
  });

  it("passes through a reason Stripe knows", async () => {
    stubStripe({ id: "re_4", status: "succeeded", amount: 4200, currency: "gbp" });
    await createStripeRefund({ ...refundArgs, reason: "duplicate" });

    expect(captured?.body.get("reason")).toBe("duplicate");
    expect(captured?.body.get("metadata[markii_reason]")).toBe("duplicate");
  });

  it("drops a reason Stripe does not know rather than coercing it to one that lies", async () => {
    stubStripe({ id: "re_5", status: "succeeded", amount: 4200, currency: "gbp" });
    await createStripeRefund({ ...refundArgs, reason: "item_unavailable" });

    // Stripe accepts three reasons; sending a fourth is a 400, and mapping it
    // onto `requested_by_customer` would write a reason nobody chose into the
    // merchant's own dashboard.
    expect(captured?.body.has("reason")).toBe(false);
    expect(captured?.body.get("metadata[markii_reason]")).toBe("item_unavailable");
  });

  it("refuses a refund Stripe reports as failed", async () => {
    stubStripe({ id: "re_6", status: "failed", amount: 4200, currency: "gbp" });
    const result = await createStripeRefund(refundArgs);

    // No money moved, so no refund row may be written off the back of it.
    expect(result.ok).toBe(false);
  });

  it("accepts a pending refund, which is money committed but not yet settled", async () => {
    stubStripe({ id: "re_7", status: "pending", amount: 4200, currency: "gbp" });
    const result = await createStripeRefund(refundArgs);

    expect(result).toMatchObject({ ok: true, status: "pending" });
  });

  it("refuses when Stripe echoes a different amount than was asked", async () => {
    stubStripe({ id: "re_8", status: "succeeded", amount: 9900, currency: "gbp" });
    const result = await createStripeRefund(refundArgs);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("9900");
  });

  it("refuses when Stripe refunds in a different currency", async () => {
    stubStripe({ id: "re_9", status: "succeeded", amount: 4200, currency: "usd" });
    const result = await createStripeRefund(refundArgs);

    expect(result.ok).toBe(false);
  });

  it("surfaces Stripe's own wording on an error", async () => {
    stubStripe({ error: { message: "Charge has already been refunded." } }, 400);
    const result = await createStripeRefund(refundArgs);

    // "Charge already refunded" and "insufficient balance" need completely
    // different actions from a merchant.
    expect(result.ok === false && result.reason).toBe("Charge has already been refunded.");
  });

  it("refuses without platform credentials instead of calling out", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    stubStripe({ id: "re_10", status: "succeeded" });
    const result = await createStripeRefund(refundArgs);

    expect(result.ok).toBe(false);
    expect(captured).toBeNull();
  });
});

describe("refundIdempotencyKey", () => {
  it("is identical for a retry of the same refund", () => {
    // The failure it guards: Stripe accepted, the transaction did not commit,
    // and the merchant tries again. Same order, same prior state, same amount.
    expect(refundIdempotencyKey(42, 0, 4200)).toBe(refundIdempotencyKey(42, 0, 4200));
  });

  it("differs for a second partial refund on the same order", () => {
    // Once the first £42 committed, `refundedMinor` moved — so an identical
    // second request is a genuinely new refund and must not collide.
    expect(refundIdempotencyKey(42, 0, 4200)).not.toBe(refundIdempotencyKey(42, 4200, 4200));
  });

  it("differs across orders that refund the same amount", () => {
    expect(refundIdempotencyKey(42, 0, 4200)).not.toBe(refundIdempotencyKey(43, 0, 4200));
  });
});

describe("accepted", () => {
  it("counts the statuses that mean money is committed to going back", () => {
    expect(accepted("succeeded")).toBe(true);
    expect(accepted("pending")).toBe(true);
  });

  it("rejects everything else, including requires_action", () => {
    // `requires_action` means the shopper still has to do something; nothing is
    // committed, so recording a refund would be premature.
    expect(accepted("requires_action")).toBe(false);
    expect(accepted("failed")).toBe(false);
    expect(accepted("canceled")).toBe(false);
  });
});
