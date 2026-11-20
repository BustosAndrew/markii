import { describe, expect, it } from "vitest";
import "../actions/index";
import { getAction } from "../actions/registry";
import {
  hashStorefrontKey,
  mintStorefrontKey,
  SHOPPER_EMAIL_HEADER,
  shopperEmailFrom,
  STOREFRONT_KEY_PREFIX,
  storefrontKeyFrom,
} from "./storefront-key-format";

/**
 * Storefront secret keys (D53) — the pure half, and the registry flags that
 * decide who may mint one. Whoever holds a key can act as any customer of its
 * store, so the flags are pinned rather than left to review.
 */

const h = (init: Record<string, string>) => new Headers(init);

describe("storefront secret keys", () => {
  it("mints a prefixed key whose hash, not plaintext, is what gets stored", () => {
    const k = mintStorefrontKey();
    expect(k.plaintext.startsWith(STOREFRONT_KEY_PREFIX)).toBe(true);
    expect(k.hash).toBe(hashStorefrontKey(k.plaintext));
    expect(k.hash).not.toContain(k.plaintext);
    expect(k.plaintext.startsWith(k.prefix)).toBe(true);
    expect(k.prefix.length).toBeLessThan(k.plaintext.length - 20);
    expect(mintStorefrontKey().plaintext).not.toBe(k.plaintext);
  });

  it("reads only its own bearer shape — a staff token sent to a storefront is not a key", () => {
    expect(storefrontKeyFrom(h({ authorization: `Bearer ${STOREFRONT_KEY_PREFIX}abc` }))).toBe(`${STOREFRONT_KEY_PREFIX}abc`);
    expect(storefrontKeyFrom(h({ authorization: "Bearer mk_live_staff" }))).toBeNull();
    expect(storefrontKeyFrom(h({}))).toBeNull();
  });

  it("reads the asserted shopper, lowercased, and tells absent from malformed", () => {
    expect(shopperEmailFrom(h({ [SHOPPER_EMAIL_HEADER]: " Ada@Example.COM " }))).toEqual({ email: "ada@example.com" });
    expect(shopperEmailFrom(h({}))).toEqual({ email: null });
    expect(shopperEmailFrom(h({ [SHOPPER_EMAIL_HEADER]: "not an email" }))).toEqual({ invalid: true });
  });

  it("only a person at the keyboard mints a key, and the audit row never holds it", async () => {
    const create = getAction("storefront.createKey");
    expect(create?.riskTier).toBe("high");
    expect(create?.requiresStepUp).toBe(true);
    expect(create?.agentExecution).toBeUndefined();
    expect(create?.orgWide).toBeUndefined();
    expect(create?.redactResult?.({ id: 1, prefix: "p", key: "mksk_live_secret" })).toMatchObject({ id: 1, key: expect.not.stringContaining("secret") });
    // Revoking only removes access, so it must stay quick: no step-up.
    const revoke = getAction("storefront.revokeKey");
    expect(revoke?.requiresStepUp ?? false).toBe(false);
    expect(revoke?.permission).toBe("tokens.manage");
  });
});
