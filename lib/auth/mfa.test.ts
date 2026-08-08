import { describe, expect, it } from "vitest";
import { STEP_UP_WINDOW_MS, gateFor, lastFactorAt, stepUpSatisfied } from "./mfa";

/**
 * MFA gating and step-up freshness (D40) — the pure half.
 *
 * These decide whether a merchant reaches their dashboard and whether a payout
 * address can be changed, and neither is something the type system can check.
 *
 * The window arithmetic is worth pinning for a specific reason: the first
 * version of `assertStepUp` read the AMR claim from the wrong place and always
 * saw `undefined`, so **every** marked action refused. It failed closed, which
 * is the right direction — but the integration suite is what noticed, and a unit
 * test here is cheaper than a thirty-minute run.
 */

const at = (secondsAgo: number) => [
  { method: "password", timestamp: Math.floor(Date.now() / 1000) - 9999 },
  { method: "totp", timestamp: Math.floor(Date.now() / 1000) - secondsAgo },
];

describe("gateFor", () => {
  it("sends an unenrolled merchant to enrolment", () => {
    const gate = gateFor({
      enrolled: false,
      verified: false,
      currentLevel: "aal1",
      nextLevel: "aal1",
      factorIds: [],
    });
    expect(gate.status).toBe("enroll");
  });

  /**
   * Enrolled but unverified is the state every merchant is in immediately after
   * signing in. It must ask for a code, not send them back to setup — being
   * told to enrol an authenticator they already have is a dead end.
   */
  it("asks an enrolled but unverified session for a code", () => {
    const gate = gateFor({
      enrolled: true,
      verified: false,
      currentLevel: "aal1",
      nextLevel: "aal2",
      factorIds: ["f1"],
    });
    expect(gate.status).toBe("challenge");
    if (gate.status === "challenge") expect(gate.factorIds).toEqual(["f1"]);
  });

  it("lets a verified session through", () => {
    expect(
      gateFor({
        enrolled: true,
        verified: true,
        currentLevel: "aal2",
        nextLevel: "aal2",
        factorIds: ["f1"],
      }).status,
    ).toBe("ok");
  });
});

describe("stepUpSatisfied", () => {
  it("accepts a factor presented just now", () => {
    expect(stepUpSatisfied(at(5))).toBe(true);
  });

  it("accepts one inside the window", () => {
    expect(stepUpSatisfied(at(STEP_UP_WINDOW_MS / 1000 - 60))).toBe(true);
  });

  /**
   * The whole point. A session that cleared MFA hours ago is still `aal2`, and
   * treating that as consent to move a payout address is the unattended-laptop
   * gap step-up exists to close.
   */
  it("refuses a stale factor even though the session is still aal2", () => {
    expect(stepUpSatisfied(at(STEP_UP_WINDOW_MS / 1000 + 60))).toBe(false);
    expect(stepUpSatisfied(at(60 * 60 * 8))).toBe(false);
  });

  /**
   * Fails closed. This is the case that actually occurred — the AMR claim was
   * read from the wrong property and was always absent.
   */
  it("refuses when there is no AMR at all", () => {
    expect(stepUpSatisfied(undefined)).toBe(false);
    expect(stepUpSatisfied([])).toBe(false);
  });

  /** A password is not a second factor, however recently it was typed. */
  it("does not accept a password as step-up", () => {
    expect(
      stepUpSatisfied([{ method: "password", timestamp: Math.floor(Date.now() / 1000) }]),
    ).toBe(false);
  });

  it("reads the most recent factor when several are present", () => {
    const now = Math.floor(Date.now() / 1000);
    const amr = [
      { method: "totp", timestamp: now - 60 * 60 * 8 },
      { method: "totp", timestamp: now - 10 },
    ];
    expect(stepUpSatisfied(amr)).toBe(true);
  });
});

describe("lastFactorAt", () => {
  it("is null with no MFA entry, rather than falling back to now", () => {
    expect(lastFactorAt([{ method: "password", timestamp: 1 }])).toBeNull();
    expect(lastFactorAt(undefined)).toBeNull();
  });

  it("converts Supabase's seconds to a Date", () => {
    expect(lastFactorAt([{ method: "totp", timestamp: 1_700_000_000 }])).toEqual(
      new Date(1_700_000_000 * 1000),
    );
  });
});
