import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The storefront Content-Security-Policy and the cross-origin write guard
 * (D51 M6), against a real dev server.
 *
 * What only the wiring can show: the proxy's nonce is the one Next stamps on
 * every script it renders (a mismatch blocks the page's own JavaScript, and
 * nothing else would notice until a shopper's cart stopped working), the cart
 * gets the strict policy, and a request from a sibling subdomain carrying a
 * merchant's cookies is refused before any route runs.
 */
describe("storefront CSP and cross-origin writes", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "csp");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "csp", { orgId });
    siteId = store.site.id;
    slug = store.slug;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  const policyOf = (h: Headers) => h.get("content-security-policy") ?? "";
  const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1] ?? null;

  it("stamps the policy's nonce on every executable script the page carries", async () => {
    const page = await shopper.getRaw(`/_sites/${slug}`);
    expect(page.status).toBe(200);
    const nonce = nonceOf(policyOf(page.headers));
    expect(nonce, policyOf(page.headers)).toBeTruthy();
    expect(policyOf(page.headers)).toContain("'strict-dynamic'");
    const scripts = [...page.text.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) {
      if (/type="application\/ld\+json"/.test(attrs)) continue; // data, not code
      expect(attrs, attrs).toContain(`nonce="${nonce}"`);
    }
  });

  it("mints a new nonce per request and ignores one a client sends", async () => {
    const a = nonceOf(policyOf((await shopper.getRaw(`/_sites/${slug}`)).headers));
    const res = await fetch(`${BASE_URL}/_sites/${slug}`, { headers: { "x-nonce": "attacker", "content-security-policy": "script-src 'nonce-attacker'" } });
    const b = nonceOf(policyOf(res.headers));
    const html = await res.text();
    expect(b).not.toBe(a);
    expect(b).not.toBe("attacker");
    expect(html).not.toContain('nonce="attacker"');
  });

  it("gives the cart and account the strict policy, and product pages the open one", async () => {
    for (const path of ["/cart", "/account"]) {
      const policy = policyOf((await shopper.getRaw(`/_sites/${slug}${path}`)).headers);
      const connect = /connect-src ([^;]+)/.exec(policy)?.[1] ?? "";
      expect(connect, path).toContain("https://api.stripe.com");
      expect(connect.split(" "), path).not.toContain("https:");
    }
    const product = policyOf((await shopper.getRaw(`/_sites/${slug}/p/test-product-one`)).headers);
    expect(/connect-src ([^;]+)/.exec(product)?.[1].split(" ")).toContain("https:");
  });

  it("sets no policy on storefront APIs", async () => {
    const res = await shopper.getRaw(`/_sites/${slug}/api/search?q=test`);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("refuses a sibling subdomain's write carrying the merchant's cookies, before the route runs", async () => {
    const before = (await merchant.get(`/api/builder/sites/${siteId}`)).json;
    expect(before.siteId).toBe(siteId); // the session is live, so a refusal below is the guard
    const input = { siteId };
    const sameSite = await merchant.call("POST", "/api/actions/builder.startDesign", input, { "sec-fetch-site": "same-site" });
    expect(sameSite.status).toBe(403);
    expect(sameSite.json.error.code).toBe("CROSS_ORIGIN_REFUSED");
    const byOrigin = await merchant.call("POST", "/api/actions/builder.startDesign", input, { origin: "http://evil.localhost:3000" });
    expect(byOrigin.status).toBe(403);
    expect(byOrigin.json.error.code).toBe("CROSS_ORIGIN_REFUSED");
    // Nothing happened: the design is still unstarted.
    expect((await merchant.get(`/api/builder/sites/${siteId}`)).json.started).toBe(before.started);

    // The dashboard's own page is same-origin, and works.
    const own = await merchant.call("POST", "/api/actions/builder.startDesign", input, { "sec-fetch-site": "same-origin" });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
  });

  it("guards storefronts too, and leaves cookieless callers alone", async () => {
    const res = await fetch(`${BASE_URL}/_sites/${slug}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: "markii_cart=x", "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(403);
    // A webhook: cross-site in the browser's terms would not apply, and it carries no cookie.
    const hook = await fetch(`${BASE_URL}/api/webhooks/stripe`, { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: "{}" });
    expect(hook.status).not.toBe(403);
  });
});
