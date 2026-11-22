import { describe, expect, it } from "vitest";
import {
  RedirectRuleError,
  checkRedirectFrom,
  checkRedirectTarget,
  closesLoop,
  normalizeRedirectPath,
  resolveRedirectTarget,
} from "./redirect-rules";

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof RedirectRuleError) return err.field;
    throw err;
  }
  return null;
};

describe("redirect sources", () => {
  it("matches an old link however it was pasted", () => {
    for (const pasted of ["/products/green-tea", "/Products/Green-Tea/", "https://old-shop.example/products/green-tea?variant=1#x", "//products//green-tea"]) {
      expect(normalizeRedirectPath(pasted)).toBe("/products/green-tea");
    }
    expect(normalizeRedirectPath("/products/th%C3%A9")).toBe("/products/thé");
  });

  it("refuses a link that is not a path", () => {
    expect(refusal(() => checkRedirectFrom("products/tea"))).toBe("from");
    expect(refusal(() => checkRedirectFrom("/with space"))).toBe("from");
  });

  it("refuses paths that always answer, so a rule there could never fire", () => {
    for (const p of ["/", "/collections", "/cart", "/cart/x", "/account", "/api/products", "/llms.txt", "/search"]) {
      expect(refusal(() => checkRedirectFrom(p)), p).toBe("from");
    }
  });

  it("allows what really 404s — gone products, collections, pages and any old platform's path", () => {
    for (const p of ["/collections/old-teas", "/p/retired", "/c/old", "/pages/about-us", "/products/green-tea", "/cartography"]) {
      expect(checkRedirectFrom(p)).toBe(p);
    }
  });
});

describe("redirect targets", () => {
  it("takes a path on this store or an https URL", () => {
    expect(checkRedirectTarget(" /p/green-tea?ref=old ")).toBe("/p/green-tea?ref=old");
    expect(checkRedirectTarget("https://blog.example/tea")).toBe("https://blog.example/tea");
  });

  it("refuses anything that would send a shopper somewhere unsafe or off the store unannounced", () => {
    for (const t of ["http://example.com", "javascript:alert(1)", "//evil.example/x", "https://user:pw@example.com", "data:text/html,x", "p/x"]) {
      expect(refusal(() => checkRedirectTarget(t)), t).toBe("to");
    }
  });

  it("resolves a path against the store's own address", () => {
    expect(resolveRedirectTarget("/p/tea", "https://tea.markii.shop/")).toBe("https://tea.markii.shop/p/tea");
    expect(resolveRedirectTarget("https://x.example/a", "https://tea.markii.shop")).toBe("https://x.example/a");
  });
});

describe("loops", () => {
  const rules = new Map([
    ["/a", "/b"],
    ["/b", "/c"],
  ]);

  it("finds a rule that would close a loop, however long", () => {
    expect(closesLoop("/c", "/a", rules)).toBe(true);
    expect(closesLoop("/x", "/X/", new Map())).toBe(true);
  });

  it("lets a chain end somewhere — on a page, or off the store", () => {
    expect(closesLoop("/c", "/p/tea", rules)).toBe(false);
    expect(closesLoop("/c", "https://example.com/a", rules)).toBe(false);
  });

  it("stops on a loop it is not part of", () => {
    const cyclic = new Map([
      ["/a", "/b"],
      ["/b", "/a"],
    ]);
    expect(closesLoop("/z", "/a", cyclic)).toBe(false);
  });
});
