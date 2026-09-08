import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  actionOf,
  actionUrl,
  recipientOf,
  verifyHookSignature,
  type HookPayload,
} from "./auth-hook";

/**
 * Send Email Hook verification (§24).
 *
 * This verifier has two failure modes and both are severe. Too strict and every
 * auth email stops — Supabase does not fall back once the hook is enabled, so
 * nobody can reset a password or confirm an account. Too loose and an
 * unauthenticated caller can make Markii send an attacker-chosen link **from a
 * merchant's own verified domain**, which is phishing with the merchant's
 * reputation behind it.
 */

const SECRET_BYTES = Buffer.from("markii-test-secret-key-0123456789");
const SECRET = `v1,whsec_${SECRET_BYTES.toString("base64")}`;

function sign(body: string, id: string, timestamp: string, key = SECRET_BYTES): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

const NOW = new Date("2026-08-15T12:00:00Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = JSON.stringify({ user: { id: "u1" } });

describe("verifyHookSignature", () => {
  it("accepts a correctly signed payload", () => {
    const res = verifyHookSignature(
      BODY,
      { id: "msg_1", timestamp: TS, signature: sign(BODY, "msg_1", TS) },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(true);
  });

  it("decodes the secret rather than signing its literal text", () => {
    /**
     * The classic way to ship a verifier that rejects every real request: the
     * secret arrives as `v1,whsec_<base64>` and the signing key is the decoded
     * bytes, not the string. Signing with the literal must NOT verify.
     */
    const wrong = createHmac("sha256", SECRET).update(`msg_1.${TS}.${BODY}`).digest("base64");
    const res = verifyHookSignature(
      BODY,
      { id: "msg_1", timestamp: TS, signature: `v1,${wrong}` },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(false);
  });

  it("refuses a body that changed after signing", () => {
    const res = verifyHookSignature(
      `${BODY} `,
      { id: "msg_1", timestamp: TS, signature: sign(BODY, "msg_1", TS) },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(false);
  });

  it("refuses a signature lifted onto a different message id", () => {
    // The id is part of the signed string, so a captured signature cannot be
    // replayed under a fresh id to look like a new delivery.
    const res = verifyHookSignature(
      BODY,
      { id: "msg_2", timestamp: TS, signature: sign(BODY, "msg_1", TS) },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(false);
  });

  it("refuses a replay outside the tolerance window", () => {
    /**
     * Without this, a captured request re-sent hours later would re-deliver a
     * still-valid auth token to the same address.
     */
    const old = String(Math.floor(NOW.getTime() / 1000) - 6 * 60);
    const res = verifyHookSignature(
      BODY,
      { id: "msg_1", timestamp: old, signature: sign(BODY, "msg_1", old) },
      SECRET,
      NOW,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/tolerance/);
  });

  it("accepts any of several signatures so a secret can be rolled", () => {
    // During a rotation Supabase sends space-separated signatures. Requiring the
    // first to match would drop every event mid-roll.
    const other = createHmac("sha256", Buffer.from("older-key")).update("x").digest("base64");
    const header = `v1,${other} ${sign(BODY, "msg_1", TS)}`;
    const res = verifyHookSignature(BODY, { id: "msg_1", timestamp: TS, signature: header }, SECRET, NOW);
    expect(res.ok).toBe(true);
  });

  it("refuses when the signature headers are absent entirely", () => {
    const res = verifyHookSignature(BODY, { id: null, timestamp: null, signature: null }, SECRET, NOW);
    expect(res.ok).toBe(false);
  });
});

describe("actionOf", () => {
  const payload = (type: string): HookPayload => ({
    user: { id: "u1", email: "a@b.test", app_metadata: {} },
    email_data: {
      token: "123456",
      token_hash: "hash",
      redirect_to: "https://shop.example.com/account",
      email_action_type: type,
    },
  });

  it("recognises the actions Supabase sends", () => {
    expect(actionOf(payload("signup"))).toBe("signup");
    expect(actionOf(payload("recovery"))).toBe("recovery");
    expect(actionOf(payload("email_change_new"))).toBe("email_change_new");
  });

  it("maps anything unrecognised to `unknown` rather than guessing", () => {
    // The route refuses `unknown` instead of answering 200, so a user is never
    // left waiting for mail that a silent drop said had been handled.
    expect(actionOf(payload("some_future_flow"))).toBe("unknown");
  });
});

/**
 * Which address each message goes to.
 *
 * This is the one piece of routing here with a security consequence. Supabase's
 * *Secure email change* sends two messages per change, and the second exists to
 * prove the **new** address is reachable by whoever asked. Delivering its token
 * to the old address means a change can complete for an address nobody has
 * shown control of — a typo, or someone else's inbox — which is exactly the
 * guarantee the two-message flow provides. Both were going to the current
 * address until 2026-09-08.
 */
describe("recipientOf", () => {
  const payload = (type: string, newEmail?: string | null): HookPayload => ({
    user: {
      id: "u1",
      email: "current@example.test",
      ...(newEmail === undefined ? {} : { new_email: newEmail }),
      app_metadata: {},
    },
    email_data: {
      token: "123456",
      token_hash: "hash",
      redirect_to: "https://shop.example.com/account",
      email_action_type: type,
    },
  });

  it("sends the new-address confirmation to the new address", () => {
    expect(recipientOf(payload("email_change_new", "new@example.test"))).toBe("new@example.test");
  });

  it("sends the current-address confirmation to the current address", () => {
    // This half is the takeover warning; it belongs where the account is today.
    expect(recipientOf(payload("email_change_current", "new@example.test"))).toBe(
      "current@example.test",
    );
  });

  /** Secure change off: Supabase sends one message, to the account holder. */
  it("keeps the single-message flow on the current address", () => {
    expect(recipientOf(payload("email_change", "new@example.test"))).toBe("current@example.test");
  });

  it("leaves every other action on the current address", () => {
    for (const type of ["signup", "recovery", "magiclink", "invite"]) {
      expect(recipientOf(payload(type))).toBe("current@example.test");
    }
  });

  /**
   * Degrades rather than throwing. A build that stopped receiving `new_email`
   * should still deliver to a real address; the alternative is a 500 that stops
   * the mail entirely, which is worse than a message reaching the wrong one of
   * the account's two addresses.
   */
  it("falls back to the current address when new_email is missing", () => {
    expect(recipientOf(payload("email_change_new"))).toBe("current@example.test");
    expect(recipientOf(payload("email_change_new", null))).toBe("current@example.test");
    expect(recipientOf(payload("email_change_new", ""))).toBe("current@example.test");
  });
});

describe("actionUrl", () => {
  it("uses token_hash and carries the storefront redirect through", () => {
    /**
     * The redirect is what returns the shopper to the store they started on. A
     * link that verifies and then lands them on Markii would be correct and
     * useless.
     */
    const url = new URL(
      actionUrl(
        {
          user: { id: "u1", email: "a@b.test" },
          email_data: {
            token: "123456",
            token_hash: "abc123",
            redirect_to: "https://shop.example.com/account",
            email_action_type: "signup",
          },
        },
        "https://proj.supabase.co/",
      ),
    );
    expect(url.pathname).toBe("/auth/v1/verify");
    expect(url.searchParams.get("token")).toBe("abc123");
    expect(url.searchParams.get("type")).toBe("signup");
    expect(url.searchParams.get("redirect_to")).toBe("https://shop.example.com/account");
  });
});
