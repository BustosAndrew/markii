import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  diagnoseSignatureFailure,
  parseStripeEvent,
  verifyStripeSignature,
} from "./stripe-webhook";

/**
 * The signature is the **only** authentication this endpoint has, so these
 * tests are about what must be rejected rather than what must be accepted.
 * Anything that passes here can change a merchant's billing state.
 */

const SECRET = "whsec_test_2c9f8a1b3d4e5f60718293a4b5c6d7e8";
const NOW = 1_786_000_000;

function sign(payload: string, secret = SECRET, timestamp = NOW): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const body = JSON.stringify({
  id: "evt_1",
  type: "invoice.paid",
  created: NOW,
  livemode: false,
  data: { object: { id: "in_1" } },
});

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed payload", () => {
    const r = verifyStripeSignature({
      payload: body,
      header: sign(body),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(r).toEqual({ ok: true, timestamp: NOW });
  });

  it("rejects a payload altered after signing", () => {
    // The whole point: the amount cannot be edited in flight.
    const header = sign(body);
    const tampered = body.replace('"in_1"', '"in_2"');
    const r = verifyStripeSignature({
      payload: tampered,
      header,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const r = verifyStripeSignature({
      payload: body,
      header: sign(body, "whsec_someone_elses_secret"),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "signature does not match" });
  });

  it("rejects a replayed event once it is outside tolerance", () => {
    const header = sign(body, SECRET, NOW);
    // Valid at the time…
    expect(
      verifyStripeSignature({ payload: body, header, secret: SECRET, nowSeconds: NOW + 60 }).ok,
    ).toBe(true);
    // …and not an hour later, or a captured charge.refunded replays forever.
    const later = verifyStripeSignature({
      payload: body,
      header,
      secret: SECRET,
      nowSeconds: NOW + 3600,
    });
    expect(later).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("rejects a timestamp too far in the future", () => {
    const header = sign(body, SECRET, NOW + 3600);
    const r = verifyStripeSignature({
      payload: body,
      header,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts when any v1 matches, so a secret roll does not drop events", () => {
    // Stripe signs with both secrets during a rollover.
    const good = createHmac("sha256", SECRET).update(`${NOW}.${body}`, "utf8").digest("hex");
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=${good}`;
    expect(
      verifyStripeSignature({ payload: body, header, secret: SECRET, nowSeconds: NOW }).ok,
    ).toBe(true);
  });

  it("refuses malformed and absent headers rather than throwing", () => {
    const cases: [string | null, string][] = [
      [null, "missing Stripe-Signature header"],
      ["", "missing Stripe-Signature header"],
      ["v1=abc", "signature header has no timestamp"],
      [`t=${NOW}`, "signature header has no v1 signature"],
      [`t=notanumber,v1=abc`, "signature header has no timestamp"],
    ];
    for (const [header, reason] of cases) {
      expect(
        verifyStripeSignature({ payload: body, header, secret: SECRET, nowSeconds: NOW }),
      ).toEqual({ ok: false, reason });
    }
  });

  it("refuses a non-hex signature without throwing", () => {
    const header = `t=${NOW},v1=${"z".repeat(64)}`;
    expect(
      verifyStripeSignature({ payload: body, header, secret: SECRET, nowSeconds: NOW }).ok,
    ).toBe(false);
  });

  it("refuses when no secret is configured, rather than accepting anything", () => {
    const r = verifyStripeSignature({
      payload: body,
      header: sign(body),
      secret: "",
      nowSeconds: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "no signing secret configured" });
  });
});

describe("parseStripeEvent", () => {
  it("reads the fields the router needs", () => {
    const e = parseStripeEvent(body);
    expect(e?.id).toBe("evt_1");
    expect(e?.type).toBe("invoice.paid");
    // Absent `account` is what marks an event as the platform's own.
    expect(e?.account).toBeUndefined();
  });

  it("carries the connected account when Stripe sends one", () => {
    const connect = parseStripeEvent(
      JSON.stringify({ id: "evt_2", type: "account.updated", account: "acct_1", data: {} }),
    );
    expect(connect?.account).toBe("acct_1");
  });

  it("returns null for anything that is not an event", () => {
    expect(parseStripeEvent("not json")).toBeNull();
    expect(parseStripeEvent("null")).toBeNull();
    expect(parseStripeEvent(JSON.stringify({ id: 1, type: "x" }))).toBeNull();
    expect(parseStripeEvent(JSON.stringify({ type: "x" }))).toBeNull();
  });
});

/**
 * The diagnosis exists because "signature does not match" is true and useless.
 * A signing secret from the wrong *mode* is the common cause and the one no
 * startup check can catch — every secret is a `whsec_…` in both modes, so
 * `lib/stripe-mode.ts`, which compares `sk_`/`pk_` prefixes, is blind to it.
 *
 * These assert the message actually distinguishes the cases. A diagnostic that
 * says the same thing every time is the bare reason with extra words.
 */
describe("diagnoseSignatureFailure", () => {
  const base = {
    reason: "signature does not match",
    claimedLivemode: false,
    isConnectEvent: false,
    keyIsLive: false,
  };

  it("names the mode mismatch when the payload disagrees with the key", () => {
    const msg = diagnoseSignatureFailure({ ...base, claimedLivemode: true, keyIsLive: false });

    expect(msg).toMatch(/mode mismatch/i);
    expect(msg).toMatch(/live-mode event/);
    expect(msg).toMatch(/test-mode key/);
    // The actionable part: how to get a correct secret locally.
    expect(msg).toMatch(/stripe listen/);
  });

  it("catches the mismatch in the other direction too", () => {
    const msg = diagnoseSignatureFailure({ ...base, claimedLivemode: false, keyIsLive: true });

    expect(msg).toMatch(/test-mode event/);
    expect(msg).toMatch(/live-mode key/);
  });

  it("names the Connect variable for a connected-account event", () => {
    const msg = diagnoseSignatureFailure({ ...base, isConnectEvent: true, claimedLivemode: true });

    expect(msg).toMatch(/STRIPE_CONNECT_WEBHOOK_SECRET/);
    expect(msg).not.toMatch(/STRIPE_WEBHOOK_SECRET\b(?!.*CONNECT)/);
  });

  it("does not blame the mode when the modes agree", () => {
    const msg = diagnoseSignatureFailure(base);

    expect(msg).not.toMatch(/mode mismatch/i);
    expect(msg).toMatch(/one secret per endpoint/i);
  });

  it("distinguishes clock skew from a wrong secret", () => {
    const msg = diagnoseSignatureFailure({ ...base, reason: "timestamp outside tolerance" });

    // The signature was fine. Saying "wrong secret" here sends someone to
    // rotate a secret that was never the problem.
    expect(msg).toMatch(/clock skew|replayed/i);
    expect(msg).toMatch(/not a wrong secret/i);
  });

  it("says so plainly when the secret is simply absent", () => {
    const msg = diagnoseSignatureFailure({ ...base, reason: "no signing secret configured" });

    expect(msg).toMatch(/is empty/);
  });

  /**
   * Regression: the first version returned the mode-mismatch paragraph for
   * *every* failure, so an unsigned scanner request produced a confident
   * explanation about live-versus-test secrets and sent the reader to rotate a
   * secret that was never involved.
   */
  it.each([
    "missing Stripe-Signature header",
    "signature header has no timestamp",
    "signature header has no v1 signature",
  ])("does not blame the secret when the header is unusable (%s)", (reason) => {
    const msg = diagnoseSignatureFailure({
      ...base,
      reason,
      // Deliberately mismatched: the mode hint must still not fire, because no
      // signature was presented for a secret to be wrong about.
      claimedLivemode: true,
      keyIsLive: false,
    });

    expect(msg).not.toMatch(/mode mismatch/i);
    expect(msg).not.toMatch(/stripe listen/);
    expect(msg).toMatch(/no usable Stripe signature/i);
  });

  it("falls back to the endpoint explanation when livemode is unreadable", () => {
    // A malformed payload may carry no usable `livemode`; the hint must still
    // be useful rather than asserting a mismatch it cannot know about.
    const msg = diagnoseSignatureFailure({ ...base, claimedLivemode: undefined });

    expect(msg).not.toMatch(/mode mismatch/i);
    expect(msg).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });
});
