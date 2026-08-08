import { afterEach, describe, expect, it } from "vitest";
import { matchedPublishableKey } from "./stripe-mode";

/**
 * The mode guard. This is not a style check — a `pk_live_` paired with an
 * `sk_test_` succeeds on **every server-side call** and fails only in the
 * browser, against Stripe's own card element, after a card number has been
 * typed. That mismatch was live in this repo's `.env.local` when the guard was
 * written, and it would have hit a shopper mid-checkout with stock already
 * reserved as readily as a merchant adding a billing card.
 *
 * It is unit-tested rather than integration-tested because the failure is
 * invisible to any test whose own keys happen to match — which is every test on
 * a correctly configured machine.
 */
describe("matchedPublishableKey", () => {
  const original = {
    secret: process.env.STRIPE_SECRET_KEY,
    publishable: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  };
  const set = (secret?: string, publishable?: string) => {
    if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = secret;
    if (publishable === undefined) delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = publishable;
  };

  afterEach(() => set(original.secret, original.publishable));

  it("returns the key when both are test mode", () => {
    set("sk_test_abc", "pk_test_xyz");
    expect(matchedPublishableKey()).toBe("pk_test_xyz");
  });

  it("returns the key when both are live mode", () => {
    set("sk_live_abc", "pk_live_xyz");
    expect(matchedPublishableKey()).toBe("pk_live_xyz");
  });

  it("refuses a live publishable key against a test secret", () => {
    set("sk_test_abc", "pk_live_xyz");
    expect(matchedPublishableKey()).toBeNull();
  });

  it("refuses a test publishable key against a live secret", () => {
    set("sk_live_abc", "pk_test_xyz");
    expect(matchedPublishableKey()).toBeNull();
  });

  /** Restricted keys carry the mode the same way, so they must be read the same way. */
  it("treats a restricted test key as test mode", () => {
    set("rk_test_abc", "pk_test_xyz");
    expect(matchedPublishableKey()).toBe("pk_test_xyz");
    set("rk_test_abc", "pk_live_xyz");
    expect(matchedPublishableKey()).toBeNull();
  });

  it("is null when either key is missing", () => {
    set(undefined, "pk_test_xyz");
    expect(matchedPublishableKey()).toBeNull();
    set("sk_test_abc", undefined);
    expect(matchedPublishableKey()).toBeNull();
  });
});
