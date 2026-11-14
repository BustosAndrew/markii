import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Custom code (D51 M6, `docs/BUILDER.md` §8) against a real database and dev
 * server.
 *
 * The properties that only the wiring can show: a person's custom HTML and CSS
 * reach the storefront cleaned, an API token cannot write either through any
 * door — not the high-risk CSS action and not the low-risk "add a block" —
 * and neither reaches the cart or account pages, where shoppers type
 * passwords and card details, or the documents agents read.
 */
describe("site builder — custom code (M6)", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let homeId: number;
  let token: string;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const viaToken = (id: string, input: unknown) =>
    fetch(`${BASE_URL}/api/actions/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const storefront = (path = "") => shopper.getRaw(`/_sites/${slug}${path}`);
  const home = async () => (await merchant.get(`/api/builder/sites/${siteId}/pages/${homeId}`)).json.tree;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "code");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "code", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    expect((await act("builder.startDesign", { siteId })).status).toBe(200);
    homeId = (await merchant.get(`/api/builder/sites/${siteId}`)).json.pages[0].id;
    const created = await merchant.post("/api/org/tokens", { label: "code", role: "developer" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    token = created.json.token;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("refuses CSS that could leave its style element or fetch, and names why", async () => {
    const bad = await act("builder.setCustomCss", { siteId, css: ".a{color:red}</style><script>alert(1)</script>" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION_ERROR");
    expect(bad.json.error.details.problems).toContain('Custom CSS may not contain "<".');
    const imp = await act("builder.setCustomCss", { siteId, css: "@import url(https://evil.test/x.css);" });
    expect(imp.status).toBe(400);
  });

  it("refuses an API token custom CSS — a person writes it", async () => {
    const res = await viaToken("builder.setCustomCss", { siteId, css: ".x{color:red}" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("stores a person's custom HTML cleaned, and refuses a token writing any through a generic edit", async () => {
    const section = (await home()).children[0];
    const added = await act("builder.addBlock", {
      siteId,
      pageId: homeId,
      parentId: section.id,
      type: "html",
      props: { html: '<div class="promo"><p onclick="steal()">Free returns</p><script>steal()</script><img src="x" onerror="steal()"></div>' },
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const block = (await home()).children[0].children.find((n: any) => n.id === added.json.result.nodeId);
    expect(block.props.html).toBe('<div class="promo"><p>Free returns</p></div>');

    // A token may not add custom HTML, change it, or copy it — the low-risk tree edits refuse custom code.
    const viaAdd = await viaToken("builder.addBlock", { siteId, pageId: homeId, parentId: section.id, type: "html", props: { html: "<p>token</p>" } });
    expect(viaAdd.status).toBe(403);
    expect(viaAdd.json.error.code).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(viaAdd.json.error.details.reason).toBe("custom_code");
    const viaProps = await viaToken("builder.setProps", { siteId, pageId: homeId, nodeId: block.id, props: { html: "<p>changed</p>" } });
    expect(viaProps.status).toBe(403);
    const viaCopy = await viaToken("builder.duplicateNode", { siteId, pageId: homeId, nodeId: block.id });
    expect(viaCopy.status).toBe(403);
    // …but an empty one, or removing one, is fine: taking code out is never the risk.
    const empty = await viaToken("builder.addBlock", { siteId, pageId: homeId, parentId: section.id, type: "html" });
    expect(empty.status, JSON.stringify(empty.json)).toBe(200);
    const removed = await viaToken("builder.removeNodes", { siteId, pageId: homeId, nodeIds: [empty.json.result.nodeId] });
    expect(removed.status).toBe(200);
    // The person's own block is untouched by the refused attempts.
    expect((await home()).children[0].children.find((n: any) => n.id === block.id).props.html).toBe('<div class="promo"><p>Free returns</p></div>');
  });

  it("publishes custom HTML, classes and CSS to the storefront — and keeps them off cart, account and agent documents", async () => {
    const css = await act("builder.setCustomCss", { siteId, css: ".promo { letter-spacing: 0.08em } .shout { text-transform: uppercase }" });
    expect(css.status, JSON.stringify(css.json)).toBe(200);
    const heading = (await home()).children[0].children[0];
    const cls = await act("builder.setCustomClass", { siteId, pageId: homeId, nodeId: heading.id, customClass: "shout" });
    expect(cls.status, JSON.stringify(cls.json)).toBe(200);

    // A header region carrying custom HTML too: it must vanish on the cart and account pages.
    const header = await act("builder.customizeRegion", { siteId, region: "header" });
    const headerTree = (await merchant.get(`/api/builder/sites/${siteId}/pages/${header.json.result.pageId}`)).json.tree;
    await act("builder.addBlock", { siteId, pageId: header.json.result.pageId, parentId: headerTree.id, type: "html", props: { html: '<p class="banner">Header promo</p>' } });

    expect((await act("builder.publish", { siteId })).status).toBe(200);

    const page = await storefront();
    expect(page.text).toContain('<div class="promo"><p>Free returns</p></div>');
    expect(page.text).not.toContain("steal()");
    expect(page.text).toMatch(/class="mk-b-heading [^"]*shout"/);
    expect(page.text).toContain(".shout { text-transform: uppercase }");
    expect(page.text).toContain("Header promo");

    for (const path of ["/cart", "/account"]) {
      const sensitive = await storefront(path);
      expect(sensitive.status, path).toBe(200);
      expect(sensitive.text, path).not.toContain("data-mk-custom-css");
      expect(sensitive.text, path).not.toContain("text-transform: uppercase");
      expect(sensitive.text, path).not.toContain("Header promo");
      // The designed header itself still shows — only the custom code is withheld.
      expect(sensitive.text, path).toContain("mk-region-header");
    }

    const full = await storefront("/llms-full.txt");
    expect(full.status).toBe(200);
    expect(full.text).not.toContain("Free returns");
  });

  it("restores and discards custom CSS with the rest of the design", async () => {
    const versions = (await merchant.get(`/api/builder/sites/${siteId}/versions`)).json.items;
    await act("builder.setCustomCss", { siteId, css: ".later { color: red }" });
    expect((await merchant.get(`/api/builder/sites/${siteId}`)).json.customCss).toBe(".later { color: red }");
    await act("builder.discardDraft", { siteId });
    expect((await merchant.get(`/api/builder/sites/${siteId}`)).json.customCss).toContain(".shout");

    await act("builder.setCustomCss", { siteId, css: "" });
    const restored = await act("builder.restoreVersion", { siteId, version: versions[0].version });
    expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    expect((await merchant.get(`/api/builder/sites/${siteId}`)).json.customCss).toContain(".shout");
  });

  it("undoes a CSS change through the registry", async () => {
    const set = await act("builder.setCustomCss", { siteId, css: ".undo-me { color: blue }" });
    const undone = await merchant.post("/api/actions/builder.setCustomCss/undo", { invocationId: set.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect((await merchant.get(`/api/builder/sites/${siteId}`)).json.customCss).not.toContain("undo-me");
  });
});
