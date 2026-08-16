import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signSiteRef, verifySiteRef } from "./site-ref";

/**
 * The signed storefront ref (§24).
 *
 * This value rides in **user-writable** `user_metadata`, so the signature is
 * the only thing standing between a shopper and mail sent from another
 * merchant's verified domain. Every test here is that boundary.
 */
const env = { ...process.env };
beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
});
afterEach(() => {
  process.env = { ...env };
});

describe("site ref", () => {
  it("round-trips a site id", () => {
    const ref = signSiteRef(52)!;
    expect(ref.startsWith("52.")).toBe(true);
    expect(verifySiteRef(ref)).toBe(52);
  });

  it("refuses a ref whose site id was edited", () => {
    // The attack: sign up on your own store, swap the id to a competitor's, and
    // receive a DKIM-signed email from their domain.
    const ref = signSiteRef(52)!;
    const tampered = ref.replace(/^52\./, "77.");
    expect(verifySiteRef(tampered)).toBeNull();
  });

  it("refuses a fabricated signature", () => {
    expect(verifySiteRef("77.not-a-real-mac")).toBeNull();
    expect(verifySiteRef("77.")).toBeNull();
  });

  it("refuses a signature minted under a different key", () => {
    const ref = signSiteRef(52)!;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "a-different-key";
    expect(verifySiteRef(ref)).toBeNull();
  });

  it("refuses shapes that are not refs at all", () => {
    // Reads attacker-influenced input, so malformed values must return null
    // rather than throw — the caller falls through to a refusal.
    for (const bad of [null, undefined, 42, {}, "", ".", "abc.def", "-1.x", "0.x"]) {
      expect(verifySiteRef(bad)).toBeNull();
    }
  });

  it("produces nothing when the server has no key", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(signSiteRef(52)).toBeNull();
    expect(verifySiteRef("52.anything")).toBeNull();
  });
});
