import { describe, expect, it } from "vitest";
import { cspHeaderName, cspMode, isSensitiveStorefrontPath, newNonce, storefrontCsp } from "./csp";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k, v];
    }),
  );
}

describe("storefront CSP", () => {
  it("runs only nonced scripts, and lets them load what they need", () => {
    const d = directives(storefrontCsp({ nonce: "abc", sensitive: false }));
    expect(d.get("script-src")).toEqual(expect.arrayContaining(["'nonce-abc'", "'strict-dynamic'"]));
    expect(d.get("script-src")).not.toContain("'unsafe-eval'");
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("keeps cart and account connections to the store and Stripe — no https: wildcard", () => {
    const d = directives(storefrontCsp({ nonce: "n", sensitive: true }));
    expect(d.get("connect-src")).not.toContain("https:");
    expect(d.get("connect-src")).toEqual(expect.arrayContaining(["'self'", "https://api.stripe.com"]));
    expect(d.get("frame-src")).not.toContain("https:");
    expect(d.get("frame-src")).toEqual(expect.arrayContaining(["https://js.stripe.com", "https://hooks.stripe.com"]));
    // Other pages carry analytics, which must be able to report.
    expect(directives(storefrontCsp({ nonce: "n", sensitive: false })).get("connect-src")).toContain("https:");
  });

  it("lets only the dashboard frame the preview", () => {
    const d = directives(storefrontCsp({ nonce: "n", sensitive: false, frameAncestor: "https://markii.shop" }));
    expect(d.get("frame-ancestors")).toEqual(["https://markii.shop"]);
  });

  it("adds eval only in development and upgrades only over https", () => {
    expect(storefrontCsp({ nonce: "n", sensitive: false, dev: true })).toContain("'unsafe-eval'");
    expect(storefrontCsp({ nonce: "n", sensitive: false })).not.toContain("upgrade-insecure-requests");
    expect(storefrontCsp({ nonce: "n", sensitive: false, https: true })).toContain("upgrade-insecure-requests");
  });

  it("knows which paths are sensitive", () => {
    for (const p of ["/cart", "/cart/", "/account", "/account/orders", "/cart?recover=x"]) expect(isSensitiveStorefrontPath(p), p).toBe(true);
    for (const p of ["/", "/p/shoe", "/carts", "/accounting", "/search"]) expect(isSensitiveStorefrontPath(p), p).toBe(false);
  });

  it("mints a fresh, unguessable nonce each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });

  it("enforces unless told otherwise", () => {
    expect(cspMode(undefined)).toBe("enforce");
    expect(cspMode("nonsense")).toBe("enforce");
    expect(cspMode("report-only")).toBe("report-only");
    expect(cspMode(" OFF ")).toBe("off");
    expect(cspHeaderName("report-only")).toBe("content-security-policy-report-only");
    expect(cspHeaderName("enforce")).toBe("content-security-policy");
  });
});
