import { describe, expect, it } from "vitest";
import { crossOriginWriteRefused, type CrossOriginFacts } from "./cross-origin";

const base: CrossOriginFacts = { method: "POST", host: "markii.shop", hasCookie: true, secFetchSite: null, origin: null };
const refused = (f: Partial<CrossOriginFacts>) => crossOriginWriteRefused({ ...base, ...f });

describe("cross-origin writes carrying cookies", () => {
  it("refuses a sibling subdomain posting with cookies — the case SameSite=Lax lets through", () => {
    expect(refused({ secFetchSite: "same-site" })).toBe(true);
    expect(refused({ secFetchSite: "cross-site" })).toBe(true);
    // An older browser without Sec-Fetch-Site still sends Origin on a cross-origin POST.
    expect(refused({ origin: "https://evil.markii.shop" })).toBe(true);
    expect(refused({ origin: "null" })).toBe(true);
  });

  it("allows the page's own origin and a navigation the person started", () => {
    expect(refused({ secFetchSite: "same-origin" })).toBe(false);
    expect(refused({ secFetchSite: "none" })).toBe(false);
    expect(refused({ origin: "https://markii.shop" })).toBe(false);
    expect(refused({ host: "shop.localhost:3000", origin: "http://shop.localhost:3000" })).toBe(false);
  });

  it("never touches reads, cookieless requests, or non-browser callers", () => {
    expect(refused({ method: "GET", secFetchSite: "cross-site" })).toBe(false);
    expect(refused({ method: "OPTIONS", secFetchSite: "cross-site" })).toBe(false);
    // Webhooks and buyer agents: no cookie, so no ambient authority to ride.
    expect(refused({ hasCookie: false, secFetchSite: "cross-site" })).toBe(false);
    // curl / a server / the test suite: neither header.
    expect(refused({})).toBe(false);
  });

  it("covers every mutating method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) expect(refused({ method, secFetchSite: "same-site" }), method).toBe(true);
  });
});
