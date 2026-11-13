import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * M5 — the store's agent-facing documents read its published design.
 *
 * The property worth proving end to end: what an agent is told about a store
 * is what the store publishes — a page appears in the sitemap, `llms.txt` and
 * `llms-full.txt` only once published, a page the merchant hid from search is
 * hidden from agents too, and the structured data on a page describes the
 * blocks a shopper can see.
 */
describe("site builder — agent documents from the published design (M5)", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let shippingId: number;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const storefront = (path = "") => shopper.getRaw(`/_sites/${slug}${path}`);
  const doc = async (id: number) => (await merchant.get(`/api/builder/sites/${siteId}/pages/${id}`)).json;
  const jsonLd = (html: string): any[] =>
    [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => {
      const v = JSON.parse(m[1]);
      return Array.isArray(v) ? v : [v];
    });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "docs");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "docs", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    expect((await act("builder.startDesign", { siteId })).status).toBe(200);

    const shipping = await act("builder.createPage", { siteId, handle: "shipping", title: "Shipping and returns" });
    shippingId = shipping.json.result.pageId;
    const section = (await doc(shippingId)).tree.children[0];
    await act("builder.insertNodes", {
      siteId,
      pageId: shippingId,
      placements: [
        { parentId: section.id, node: { type: "text", props: { markdown: "We ship in **two days**. See the [FAQ](/pages/shipping#faq)." } } },
        { parentId: section.id, node: { type: "faq", props: { items: [{ question: "Do you ship abroad?", answer: "Yes, to the EU." }] } } },
        { parentId: section.id, node: { type: "productGrid", props: { source: "all", limit: 2 } } },
      ],
    });
    const seo = await act("builder.updatePage", {
      siteId,
      pageId: shippingId,
      seo: { description: "Delivery times and returns", ogImage: "https://cdn.example.com/share.jpg" },
    });
    expect(seo.status, JSON.stringify(seo.json)).toBe(200);

    const secret = await act("builder.createPage", { siteId, handle: "staff-notes", title: "Staff notes" });
    await act("builder.updatePage", { siteId, pageId: secret.json.result.pageId, seo: { noindex: true } });
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("advertises nothing before publish — llms-full.txt has no pages to serve", async () => {
    expect((await storefront("/llms-full.txt")).status).toBe(404);
    expect((await storefront("/llms.txt")).text).not.toContain("## Pages");
    expect((await storefront("/sitemap.xml")).text).not.toContain("/pages/shipping");
  });

  it("lists published pages in llms.txt, agent.md and the sitemap — never the noindex one", async () => {
    const published = await act("builder.publish", { siteId });
    expect(published.status, JSON.stringify(published.json)).toBe(200);

    const llms = await storefront("/llms.txt");
    expect(llms.status).toBe(200);
    expect(llms.text).toContain(`/llms-full.txt`);
    expect(llms.text).toMatch(/- \[Shipping and returns\]\(\S+\/pages\/shipping\): Delivery times and returns/);
    expect(llms.text).not.toContain("Staff notes");

    const agent = await storefront("/agent.md");
    expect(agent.text).toContain("the store's own pages (Shipping and returns)");

    const sitemap = await storefront("/sitemap.xml");
    expect(sitemap.text).toContain("/pages/shipping</loc>");
    expect(sitemap.text).not.toContain("staff-notes");
  });

  it("serves every listed page's full text as Markdown, home first", async () => {
    const full = await storefront("/llms-full.txt");
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toContain("text/plain");
    const text = full.text;
    expect(text.startsWith(`# Test Store docs — pages`)).toBe(true);
    expect(text.indexOf("## Home")).toBeLessThan(text.indexOf("## Shipping and returns"));
    expect(text).toContain("### Shipping and returns");
    expect(text).toContain("We ship in **two days**.");
    expect(text).toMatch(/\[FAQ\]\(\S+\/pages\/shipping#faq\)/);
    expect(text).toContain("**Q: Do you ship abroad?**\n\nYes, to the EU.");
    expect(text).toMatch(/- \[Test Product One\]\(\S+\/p\/test-product-one\) — \$14\.00/);
    expect(text).not.toContain("Staff notes");
    // It is logged as an agent read like llms.txt.
    const [row] = await sql`select count(*)::int as n from agent_traffic where site_id = ${siteId} and path = '/llms-full.txt'`;
    expect(row.n).toBeGreaterThan(0);
  });

  it("gives a page WebPage, FAQPage and ItemList data, and its own share and canonical tags", async () => {
    const page = await storefront("/pages/shipping");
    expect(page.status).toBe(200);
    const types = jsonLd(page.text).map((x) => x["@type"]);
    expect(types).toEqual(expect.arrayContaining(["WebPage", "FAQPage", "ItemList"]));
    const webPage = jsonLd(page.text).find((x) => x["@type"] === "WebPage");
    expect(webPage).toMatchObject({ name: "Shipping and returns", description: "Delivery times and returns" });
    expect(webPage.url).toMatch(/\/pages\/shipping$/);
    expect(page.text).toContain('<meta property="og:image" content="https://cdn.example.com/share.jpg"');
    expect(page.text).toMatch(/<link rel="canonical" href="[^"]+\/pages\/shipping"/);
  });

  it("gives the home page WebSite data with a search action, designed or not", async () => {
    const home = await storefront();
    const site = jsonLd(home.text).find((x) => x["@type"] === "WebSite");
    expect(site?.potentialAction?.target).toMatch(/\/search\?q=\{search_term_string\}$/);
    // The seeded home grid is a listing too.
    expect(jsonLd(home.text).some((x) => x["@type"] === "ItemList")).toBe(true);
  });

  it("keeps llms-full.txt behind agent discovery, like llms.txt", async () => {
    await sql`update sites set agent_discovery = false where id = ${siteId}`;
    try {
      expect((await storefront("/llms-full.txt")).status).toBe(404);
    } finally {
      await sql`update sites set agent_discovery = true where id = ${siteId}`;
    }
  });

  it("saves the whole SEO object, so a later save does not drop the share image", async () => {
    // The editor's form always sends every field; the action replaces seo whole.
    const replaced = await act("builder.updatePage", { siteId, pageId: shippingId, seo: { description: "New summary" } });
    expect(replaced.status).toBe(200);
    expect((await doc(shippingId)).seo).toEqual({ description: "New summary" });
    const bad = await act("builder.updatePage", { siteId, pageId: shippingId, seo: { ogImage: "http://insecure.test/a.jpg" } });
    expect(bad.status).toBe(400);
  });
});
