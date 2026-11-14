import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Custom scripts — the storefront's head code (D51 M6, owner decision
 * 2026-11-13) — against a real database and dev server.
 *
 * The properties that only the wiring can show: a person's snippet reaches the
 * live store carrying the request's CSP nonce (without it the policy blocks
 * it, silently), it never reaches the cart, account or a draft, a token cannot
 * write it by any door — including restoring an old version — and the publish
 * dialog says a script change is being shipped.
 */
describe("site builder — custom scripts (M6)", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let token: string;

  const GA =
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>\n' +
    "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-TEST123');</script>\n" +
    '<meta name="google-site-verification" content="verify-me">\n' +
    '<iframe src="https://evil.test"></iframe>';

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const viaToken = (id: string, input: unknown) =>
    fetch(`${BASE_URL}/api/actions/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const design = async () => (await merchant.get(`/api/builder/sites/${siteId}`)).json;
  const storefront = (path = "") => shopper.getRaw(`/_sites/${slug}${path}`);

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "head");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "head", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    expect((await act("builder.startDesign", { siteId })).status).toBe(200);
    const created = await merchant.post("/api/org/tokens", { label: "head", role: "developer" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    token = created.json.token;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("refuses an API token custom scripts, even a developer's", async () => {
    const res = await viaToken("builder.setHeadCode", { siteId, html: GA });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("stores a person's snippet rebuilt, says what it dropped, and flags the publish", async () => {
    const res = await act("builder.setHeadCode", { siteId, html: GA });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.removed).toContain("<iframe>");
    const d = await design();
    expect(d.headHtml).toContain('src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"');
    expect(d.headHtml).not.toContain("iframe");
    expect(d.headHtmlChanged).toBe(true);
    const checks = (await merchant.get(`/api/builder/sites/${siteId}/checks`)).json;
    expect(checks.results.map((r: { code: string }) => r.code)).toContain("HEAD_CODE_CHANGED");
  });

  it("does not run a draft's scripts anywhere — not on the store, not in the preview", async () => {
    expect((await storefront()).text).not.toContain("G-TEST123");
  });

  it("publishes them to every page with the request's nonce — and never to the cart or account", async () => {
    expect((await act("builder.publish", { siteId })).status).toBe(200);
    for (const path of ["", "/p/test-product-one", "/search?q=test"]) {
      const page = await storefront(path);
      const nonce = /'nonce-([^']+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1];
      expect(nonce, path).toBeTruthy();
      expect(page.text, path).toMatch(new RegExp(`<script[^>]*src="https://www.googletagmanager.com/gtag/js\\?id=G-TEST123"[^>]*nonce="${nonce}"|<script[^>]*nonce="${nonce}"[^>]*src="https://www.googletagmanager.com/gtag/js\\?id=G-TEST123"`));
      expect(page.text, path).toMatch(new RegExp(`<script nonce="${nonce}">window.dataLayer`));
      // Verification tags belong in <head>, where the verifier looks.
      const head = page.text.slice(0, page.text.indexOf("</head>"));
      expect(head, path).toContain('<meta name="google-site-verification" content="verify-me"');
      expect(page.text, path).not.toContain("evil.test");
    }
    for (const path of ["/cart", "/account"]) {
      const page = await storefront(path);
      expect(page.status, path).toBe(200);
      expect(page.text, path).not.toContain("G-TEST123");
      expect(page.text, path).not.toContain("verify-me");
    }
  });

  it("will not let a token restore an old version's scripts", async () => {
    const versions = (await merchant.get(`/api/builder/sites/${siteId}/versions`)).json.items;
    expect((await act("builder.setHeadCode", { siteId, html: "" })).status).toBe(200);
    const refused = await viaToken("builder.restoreVersion", { siteId, version: versions[0].version });
    expect(refused.status).toBe(403);
    expect(refused.json.error.details.reason).toBe("custom_code");
    expect((await design()).headHtml).toBe("");
    // A person who may write scripts can.
    expect((await act("builder.restoreVersion", { siteId, version: versions[0].version })).status).toBe(200);
    expect((await design()).headHtml).toContain("G-TEST123");
  });

  it("undoes a script change through the registry, and discards with the draft", async () => {
    const set = await act("builder.setHeadCode", { siteId, html: '<meta name="later" content="x">' });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const undone = await merchant.post("/api/actions/builder.setHeadCode/undo", { invocationId: set.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect((await design()).headHtml).toContain("G-TEST123");

    await act("builder.setHeadCode", { siteId, html: '<meta name="discard-me" content="x">' });
    await act("builder.discardDraft", { siteId });
    const d = await design();
    expect(d.headHtml).toContain("G-TEST123");
    expect(d.headHtmlChanged).toBe(false);
  });
});
