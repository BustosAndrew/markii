import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStripeEvent, verifyStripeSignature } from "./stripe-webhook";

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
