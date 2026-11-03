import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Templates, global regions and data binding (D51 M4) against a real database
 * and dev server.
 *
 * The unit tests hold the whitelist and the checks; what only this can show is
 * the wiring — that a product page really renders the published template with
 * *that* product's data and a working Buy block, that a header edited once
 * reaches every page including the cart, that the route's own structured data
 * survives a redesign, and that a reset puts the built-in layout back.
 */
describe("site builder — templates and regions (M4)", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let storeName: string;
  let productTemplateId: number;
  let headerId: number;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const storefront = (path = "") => shopper.getRaw(`/_sites/${slug}${path}`);
  const doc = async (id: number) => (await merchant.get(`/api/builder/sites/${siteId}/pages/${id}`)).json;
  const summary = async () => (await merchant.get(`/api/builder/sites/${siteId}`)).json;
  const nodes = (tree: any): any[] => [tree, ...(tree.children ?? []).flatMap(nodes)];

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "templates");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "templates", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    storeName = store.site.name;
    const [one, two, three] = store.products;
    // Product One recommends Two; Two recommends nothing — so the related section shows on one page only.
    await sql`update products set suggested_product_ids = ${sql.json([two.id])}, description = ${"<p>Soft <b>merino</b> wool.</p>"} where id = ${one.id}`;
    const [coll] = await sql`insert into collections (site_id, title, handle, description, type, published_at)
      values (${siteId}, 'Winter picks', 'winter', 'Warm things.', 'manual', now()) returning id`;
    await sql`insert into collection_products (collection_id, product_id, position) values (${coll.id}, ${three.id}, 0)`;
    await sql`insert into collections (site_id, title, handle, type, published_at)
      values (${siteId}, 'Empty shelf', 'empty', 'manual', now())`;
    expect((await act("builder.startDesign", { siteId })).status).toBe(200);
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("lists the templates and regions as not customised, with somewhere to preview them", async () => {
    const s = await summary();
    expect(s.templates.map((t: any) => [t.handle, t.customized, t.id])).toEqual([
      ["product", false, null],
      ["collection", false, null],
    ]);
    expect(s.templates[0].previewPath).toBe("/p/test-product-one");
    expect(s.templates[1].previewPath).toBe("/collections/winter");
    expect(s.regions.map((r: any) => r.handle)).toEqual(["announcement", "header", "footer"]);
    // Nothing customised: every page is the fixed storefront.
    const product = await storefront("/p/test-product-one");
    expect(product.text).toContain("sf-product");
    expect(product.text).not.toContain('class="mk-page"');
  });

  it("customises the product template idempotently, and only publishing changes the product page", async () => {
    const first = await act("builder.customizeTemplate", { siteId, template: "product" });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.result.created).toBe(true);
    productTemplateId = first.json.result.pageId;
    const again = await act("builder.customizeTemplate", { siteId, template: "product" });
    expect(again.json.result).toMatchObject({ pageId: productTemplateId, created: false, revision: null });

    const tpl = await doc(productTemplateId);
    expect(tpl.kind).toBe("template");
    const h1 = nodes(tpl.tree).find((n) => n.type === "heading" && n.props.level === 1);
    expect(h1.bindings).toEqual({ text: "product.title" });

    expect((await storefront("/p/test-product-one")).text).not.toContain('class="mk-page"');

    // Restyle it so the published page is distinguishable from the fixed one.
    const set = await act("builder.setProps", { siteId, pageId: productTemplateId, nodeId: h1.id, props: { text: "Placeholder name" } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const published = await act("builder.publish", { siteId });
    expect(published.status, JSON.stringify(published.json)).toBe(200);

    const one = await storefront("/p/test-product-one");
    expect(one.status).toBe(200);
    expect(one.text).toContain('class="mk-page"');
    // The binding wins over the placeholder, per product.
    expect(one.text).toMatch(/<h1[^>]*>Test Product One<\/h1>/);
    expect(one.text).not.toContain("Placeholder name");
    expect(one.text).toContain("$14.00");
    expect(one.text).toContain("60 in stock");
    // Description arrives as text: the markup is gone, the words are not.
    expect(one.text).toContain("Soft merino wool.");
    expect(one.text).not.toContain("<b>merino</b>");
    // The Buy block is the real island, and the route's Product JSON-LD survives the redesign.
    expect(one.text).toContain("sf-cart-island");
    expect(one.text).toContain('id="product-jsonld"');
    // Related products: a repeater over Product One's suggestions.
    expect(one.text).toContain("You might also like");
    expect(one.text).toContain("Test Product Two");

    const two = await storefront("/p/test-product-two");
    expect(two.text).toMatch(/<h1[^>]*>Test Product Two<\/h1>/);
    // No suggestions → the related section's condition hides it.
    expect(two.text).not.toContain("You might also like");
    // A disabled or unknown product is still a 404, template or not.
    expect((await storefront("/p/nope")).status).toBe(404);
  });

  it("refuses a binding of the wrong type, and a product block outside the product template", async () => {
    const tpl = await doc(productTemplateId);
    const h1 = nodes(tpl.tree).find((n) => n.type === "heading" && n.props.level === 1);
    const wrong = await act("builder.setBinding", { siteId, pageId: productTemplateId, nodeId: h1.id, bindings: { text: "product.image" } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.message).toMatch(/image/);

    const home = (await summary()).pages.find((p: any) => p.handle === "home");
    const homeTree = (await doc(home.id)).tree;
    const buy = await act("builder.addBlock", { siteId, pageId: home.id, parentId: homeTree.children[0].id, type: "productBuy" });
    expect(buy.status, JSON.stringify(buy.json)).toBe(200);
    const blocked = await act("builder.publish", { siteId });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.checks.map((c: any) => c.code)).toContain("BLOCK_NEEDS_TEMPLATE");
    await act("builder.removeNodes", { siteId, pageId: home.id, nodeIds: [buy.json.result.nodeId] });
  });

  it("will not publish a product template with no Buy block", async () => {
    const buy = nodes((await doc(productTemplateId)).tree).find((n) => n.type === "productBuy");
    const removed = await act("builder.removeNodes", { siteId, pageId: productTemplateId, nodeIds: [buy.id] });
    expect(removed.status).toBe(200);
    const blocked = await act("builder.publish", { siteId });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.checks.map((c: any) => c.code)).toContain("MISSING_BUY_BLOCK");
    // Undo puts it back — the removed subtree is in the audit record.
    const undone = await merchant.post("/api/actions/builder.removeNodes/undo", { invocationId: removed.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect(nodes((await doc(productTemplateId)).tree).some((n) => n.type === "productBuy")).toBe(true);
  });

  it("renders the collection template with the collection's data, and its empty state by condition", async () => {
    const made = await act("builder.customizeTemplate", { siteId, template: "collection" });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect((await act("builder.publish", { siteId })).status).toBe(200);

    const winter = await storefront("/collections/winter");
    expect(winter.text).toContain('class="mk-page"');
    expect(winter.text).toMatch(/<h1[^>]*>Winter picks<\/h1>/);
    expect(winter.text).toContain("Warm things.");
    expect(winter.text).toContain("Test Product Three");
    expect(winter.text).not.toContain("Test Product One");
    expect(winter.text).not.toContain("Nothing in this collection right now.");
    expect(winter.text).toContain('"@type":"CollectionPage"');

    const empty = await storefront("/collections/empty");
    expect(empty.text).toMatch(/<h1[^>]*>Empty shelf<\/h1>/);
    expect(empty.text).toContain("Nothing in this collection right now.");
    // No description → the bound description block is hidden, not rendered as its placeholder.
    expect(empty.text).not.toContain("The collection&#x27;s description.");
    expect(empty.text).not.toContain("The collection's description.");
  });

  it("shows a published header on every page — fixed pages, builder pages and the cart", async () => {
    const made = await act("builder.customizeRegion", { siteId, region: "header" });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    headerId = made.json.result.pageId;
    const menu = nodes((await doc(headerId)).tree).find((n) => n.type === "navMenu");
    const edited = await act("builder.setProps", {
      siteId,
      pageId: headerId,
      nodeId: menu.id,
      props: { items: [{ label: "Our story", href: "/pages/story" }] },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect((await storefront("/cart")).text).not.toContain("Our story");

    const footer = await act("builder.customizeRegion", { siteId, region: "footer" });
    expect(footer.status).toBe(200);
    expect((await act("builder.publish", { siteId })).status).toBe(200);

    for (const path of ["", "/cart", "/search?q=test", "/collections", "/p/test-product-one", "/collections/winter"]) {
      const page = await storefront(path);
      expect(page.status, path).toBe(200);
      expect(page.text, path).toContain("mk-region-header");
      expect(page.text, path).toContain("Our story");
      expect(page.text, path).toContain(`© ${new Date().getUTCFullYear()} ${storeName}`);
      // Never the fixed header as well.
      expect(page.text.match(/class="sf-header[" ]/g)?.length ?? 0, path).toBe(1);
    }
    // The search box keeps what was searched.
    expect((await storefront("/search?q=merino")).text).toContain('value="merino"');
  });

  it("marks each document in the preview, so a click on the header opens the header", async () => {
    const minted = await merchant.post(`/api/builder/sites/${siteId}/preview-session`, {});
    expect(minted.status).toBe(201);
    const path = new URL(minted.json.url).pathname;
    const page = await shopper.getRaw(`${path}/p/test-product-one`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`data-mk-doc="${headerId}"`);
    expect(page.text).toContain(`data-mk-doc="${productTemplateId}"`);
    expect(page.text).toContain("docId:doc?doc.getAttribute");
    // The live storefront carries none of it.
    expect((await storefront("/p/test-product-one")).text).not.toContain("data-mk-doc");
  });

  it("resets a region to the built-in layout at the next publish, and undo brings it back first", async () => {
    const reset = await act("builder.deletePage", { siteId, pageId: headerId });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    expect((await summary()).regions.find((r: any) => r.handle === "header")).toMatchObject({ customized: false, deleted: true });
    // Still live until publish.
    expect((await storefront("/cart")).text).toContain("mk-region-header");

    const undone = await merchant.post("/api/actions/builder.deletePage/undo", { invocationId: reset.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect((await summary()).regions.find((r: any) => r.handle === "header").customized).toBe(true);

    await act("builder.deletePage", { siteId, pageId: headerId });
    expect((await act("builder.publish", { siteId })).status).toBe(200);
    const cart = await storefront("/cart");
    expect(cart.text).not.toContain("mk-region-header");
    expect(cart.text).toContain("sf-header");
    expect((await summary()).regions.find((r: any) => r.handle === "header")).toMatchObject({ customized: false, id: null });
  });

  it("undoing a customise removes the template from the draft", async () => {
    const made = await act("builder.customizeRegion", { siteId, region: "announcement" });
    expect(made.json.result.created).toBe(true);
    const undone = await merchant.post("/api/actions/builder.customizeRegion/undo", { invocationId: made.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect((await summary()).regions.find((r: any) => r.handle === "announcement")).toMatchObject({ customized: false, deleted: true });
  });

  it("renders a repeater over the store's products on an ordinary page", async () => {
    const home = (await summary()).pages.find((p: any) => p.handle === "home");
    const root = (await doc(home.id)).tree;
    const preset = await act("builder.insertPreset", { siteId, pageId: home.id, parentId: root.id, preset: "productCards" });
    expect(preset.status, JSON.stringify(preset.json)).toBe(200);
    expect((await act("builder.publish", { siteId })).status).toBe(200);
    const page = await storefront();
    expect(page.text).toContain('class="mk-b-repeater');
    for (const name of ["Test Product One", "Test Product Two", "Test Product Three"]) expect(page.text).toContain(name);
  });
});
