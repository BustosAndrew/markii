import { afterEach, describe, expect, it } from "vitest";
import { tenantFallbackSender } from "./identity";

/**
 * The storefront's own sending address (§24).
 *
 * Used only when a merchant has no verified domain, and only for shopper
 * account mail — the template restriction is enforced in `sendMerchantMail`,
 * and tested there. What matters here is the address itself: it has to carry
 * the store's identity, and it must not exist at all in local development,
 * where no such SES identity does.
 */
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("tenantFallbackSender", () => {
  it("sends from the storefront's own subdomain, named for the store", () => {
    process.env.ROOT_DOMAIN = "markii.shop";
    expect(tenantFallbackSender({ slug: "aurora-supply", storeName: "Aurora Supply Co." })).toEqual({
      address: "accounts@aurora-supply.markii.shop",
      // The shopper sees the store, not the platform — that is the whole point
      // of preferring this over a bare markii.shop address.
      name: "Aurora Supply Co.",
      replyTo: null,
    });
  });

  it("has no address in local development", () => {
    // `*.localhost` is not a verified SES identity and never will be; returning
    // one would produce a send that fails at AWS rather than a clean refusal.
    for (const root of ["localhost", "app.localhost", ""]) {
      process.env.ROOT_DOMAIN = root;
      expect(tenantFallbackSender({ slug: "s", storeName: "S" })).toBeNull();
    }
  });
});
