import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Collections on the storefront (§18.2, §23 `/collections/{handle}`).
 *
 * The merchant side has been live since July; what had never existed was the
 * page a published collection shows up on. So the assertions are about the
 * publish switch and the enabled filter reaching a shopper and an agent: a
 * draft collection is as absent as one that never existed, a disabled product
 * cannot come back through a collection, an automated collection is its rules
 * evaluated now, and `llms.txt` and the sitemap list what the pages serve.
 */
describe("storefront collections", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let slug: string;
  let siteId: number;
  let products: any[];
  const stamp = Date.now();

  const page = (p: string) => shopper.getRaw(`/_sites/${slug}${p}`);

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "collections");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "collections", { orgId });
    slug = store.slug;
    siteId = store.site.id;
    products = store.products;
  });

  afterAll(async () => {
    await cleanup.run();
  });

  it("lists nothing, links nothing, and 404s a handle while no collection is published", async () => {
    const draft = await merchant.invoke("catalog.createCollection", {
      siteId,
      title: "Draft Picks",
      handle: `draft-${stamp}`,
      published: false,
    });
    expect(draft.status).toBe(200);

    const index = await page("/collections");
    expect(index.status).toBe(200);
    expect(index.text).not.toContain("Draft Picks");
    expect((await page(`/collections/draft-${stamp}`)).status).toBe(404);

    const home = await page("/");
    expect(home.text).not.toMatch(/>Collections</);
    const llms = await page("/llms.txt");
    expect(llms.text).not.toContain("## Collections");
  });

  it("renders a published manual collection in its own order, minus disabled products", async () => {
    const created = await merchant.invoke("catalog.createCollection", {
      siteId,
      title: "Staff Picks",
      handle: `staff-picks-${stamp}`,
      description: "<p>What we <strong>reach for</strong>.</p>",
      published: true,
    });
    expect(created.status).toBe(200);
    const collectionId = created.json.result.id;
    await merchant.invoke("catalog.setCollectionProducts", {
      collectionId,
      productIds: [products[2].id, products[0].id, products[1].id],
    });
    await sql`update products set enabled = false where id = ${products[1].id}`;

    const res = await page(`/collections/staff-picks-${stamp}`).finally(
      () => sql`update products set enabled = true where id = ${products[1].id}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("Staff Picks");
    // Tags stripped for the page and the docs; the stripper leaves a space where a tag was.
    expect(res.text).toMatch(/What we reach for ?\./);
    expect(res.text).not.toContain("<strong>reach for</strong>");
    expect(res.text).toContain("Test Product Three");
    expect(res.text).toContain("Test Product One");
    expect(res.text).not.toContain("Test Product Two");
    // Manual order, not catalogue order.
    expect(res.text.indexOf("Test Product Three")).toBeLessThan(res.text.indexOf("Test Product One"));

    // The set is readable without visiting each card.
    const ld = res.text.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
    expect(ld).toBeTruthy();
    const json = JSON.parse(ld![1]);
    expect(json["@type"]).toBe("CollectionPage");
    expect(json.mainEntity.numberOfItems).toBe(2);
    expect(json.mainEntity.itemListElement[0].url).toContain("/p/test-product-three");
  });

  it("evaluates an automated collection's rules at read time", async () => {
    const created = await merchant.invoke("catalog.createCollection", {
      siteId,
      title: "Under Twenty",
      handle: `under-twenty-${stamp}`,
      type: "automated",
      rules: [{ field: "price", op: "lt", value: "2000" }],
      published: true,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);

    const before = await page(`/collections/under-twenty-${stamp}`);
    expect(before.text).toContain("Test Product One"); // 1400
    expect(before.text).toContain("Test Product Two"); // 1900
    expect(before.text).not.toContain("Test Product Three"); // 3800

    // A price change moves membership with no republish — rules are not materialised.
    await sql`update products set price_cents = 2500 where id = ${products[1].id}`;
    const after = await page(`/collections/under-twenty-${stamp}`);
    expect(after.text).not.toContain("Test Product Two");
    await sql`update products set price_cents = 1900 where id = ${products[1].id}`;
  });

  it("lists published collections on the index, the header, llms.txt and the sitemap", async () => {
    const index = await page("/collections");
    expect(index.text).toContain("Staff Picks");
    expect(index.text).toContain("Under Twenty");
    expect(index.text).not.toContain("Draft Picks");

    const home = await page("/");
    expect(home.text).toMatch(/href="[^"]*\/collections">Collections</);

    const llms = await page("/llms.txt");
    expect(llms.text).toContain("## Collections");
    expect(llms.text).toContain(`/collections/staff-picks-${stamp}): What we reach for`);
    expect(llms.text).not.toContain(`draft-${stamp}`);

    await sql`update sites set indexed = true where id = ${siteId}`;
    const sitemap = await page("/sitemap.xml");
    expect(sitemap.text).toContain(`/collections/under-twenty-${stamp}</loc>`);
    expect(sitemap.text).not.toContain(`draft-${stamp}`);
  });

  it("unpublishing takes the page down at once", async () => {
    const [row] = await sql`select id from collections where site_id = ${siteId} and handle = ${`staff-picks-${stamp}`}`;
    const res = await merchant.invoke("catalog.updateCollection", { collectionId: row.id, published: false });
    expect(res.status).toBe(200);
    expect((await page(`/collections/staff-picks-${stamp}`)).status).toBe(404);
    expect((await page("/llms.txt")).text).not.toContain("Staff Picks");
  });

  it("is 404 on a paused store like every other storefront page", async () => {
    await sql`update sites set status = 'paused' where id = ${siteId}`;
    try {
      expect((await page(`/collections/under-twenty-${stamp}`)).status).toBe(404);
      expect((await page("/collections")).status).toBe(404);
    } finally {
      await sql`update sites set status = 'live' where id = ${siteId}`;
    }
  });
});
