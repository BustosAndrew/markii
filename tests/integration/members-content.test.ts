import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Members-only posts and pages (§18.9, migration 0054) against a real database
 * and dev server. The rule under test is one sentence — **a gated body reaches
 * a member and nobody else** — and it has to hold on every surface that could
 * carry it: the storefront page, the blog index, the feed, `llms.txt`,
 * `llms-full.txt`, the read API, `GET /api/store`'s published design, and the
 * export's keyed calls. So each test reads the same secret sentence and
 * asserts where it may and may not appear.
 */
describe("members-only content", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  const stamp = Date.now();
  const member = `member-${stamp}@example.com`;
  const stranger = `stranger-${stamp}@example.com`;
  const SECRET = `The house blend is sencha and genmaicha ${stamp}.`;
  const PAGE_SECRET = `Club tasting notes ${stamp}.`;
  let siteId: number;
  let slug: string;
  let tierId: number;
  let joinSlug: string;
  let key: string;
  let postId: number;
  let pageId: number;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const ok = async (id: string, input: unknown) => {
    const res = await act(id, input);
    expect(res.status, `${id}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  };
  const page = (path: string) => shopper.getRaw(`/_sites/${slug}${path}`);
  /** What an exported store's server sends: no cookies, no Origin. */
  async function server(path: string, opts: { key?: string; email?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    if (opts.email) headers["markii-shopper-email"] = opts.email;
    const res = await fetch(`${BASE_URL}/_sites/${slug}${path}`, { headers });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
  }

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "members");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "members", { orgId });
    siteId = store.site.id;
    slug = store.slug;

    const [tier] = await sql`insert into membership_tiers (site_id, name, handle) values (${siteId}, 'Tea Club', ${`club-${stamp}`}) returning id`;
    tierId = tier.id;
    // The product that sells the tier is where "Join" goes.
    joinSlug = store.products[1].slug;
    await sql`update products set grants_tier_id = ${tierId} where id = ${store.products[1].id}`;
    const [customer] = await sql`insert into customers (site_id, email) values (${siteId}, ${member}) returning id`;
    await sql`insert into customer_memberships (customer_id, tier_id, source) values (${customer.id}, ${tierId}, 'manual')`;

    const created = await ok("storefront.createKey", { siteId, label: "Export" });
    key = created.result.key;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("refuses a tier the store does not have", async () => {
    const res = await act("blog.createPost", { siteId, title: "Nope", requiresTierId: 2_000_000_000 });
    expect(res.status).toBe(409);
  });

  it("shows a members-only post's title and a way to join — and its body to nobody but members", async () => {
    const created = await ok("blog.createPost", { siteId, title: "The house blend", body: `${SECRET}\n\nMore for members.`, requiresTierId: tierId });
    postId = created.result.postId;
    await ok("blog.publishPost", { postId });

    const post = await page("/blog/the-house-blend");
    expect(post.status).toBe(200);
    expect(post.text).toContain("The house blend");
    expect(post.text).toContain("This post is for Tea Club members.");
    expect(post.text).toContain(`/p/${joinSlug}`);
    expect(post.text).not.toContain(SECRET);
    expect(post.text).toContain('"isAccessibleForFree":false');

    const index = await page("/blog");
    expect(index.text).toContain("The house blend");
    expect(index.text).toContain("Members only");
    expect(index.text).not.toContain(SECRET);

    const feed = await page("/blog/feed.xml");
    expect(feed.text).toContain("The house blend");
    expect(feed.text).toContain("<category>Members only</category>");
    expect(feed.text).not.toContain(SECRET);

    expect((await page("/llms.txt")).text).toMatch(/The house blend\]\([^)]+\): Members only\./);
    expect((await page("/llms-full.txt")).text ?? "").not.toContain(SECRET);
  });

  it("the read API sends the body to a member's export server only, and never from a shared cache", async () => {
    const list = await server("/api/blog/posts");
    const listed = list.json.posts.find((p: { handle: string }) => p.handle === "the-house-blend");
    expect(listed).toMatchObject({ membersOnly: true, requiresTierId: tierId, excerpt: "" });
    expect(list.text).not.toContain(SECRET);

    const guest = await server("/api/blog/posts/the-house-blend");
    expect(guest.status).toBe(200);
    expect(guest.json).toMatchObject({ locked: true, body: "", gate: { tierName: "Tea Club" } });
    expect(guest.json.gate.join.map((j: { slug: string }) => j.slug)).toEqual([joinSlug]);
    expect(guest.headers.get("cache-control")).toBe("private, no-store");
    expect(guest.text).not.toContain(SECRET);

    expect((await server("/api/blog/posts/the-house-blend", { key, email: stranger })).json).toMatchObject({ locked: true, body: "" });
    const unlocked = await server("/api/blog/posts/the-house-blend", { key, email: member });
    expect(unlocked.json.locked).toBe(false);
    expect(unlocked.json.body).toContain(SECRET);
    expect(unlocked.headers.get("cache-control")).toBe("private, no-store");
    // A wrong key is a refusal, not a quiet guest.
    expect((await server("/api/blog/posts/the-house-blend", { key: "mksk_live_wrong", email: member })).status).toBe(401);
  });

  it("gates a page with the design: draft first, live at publish, withheld from the public design", async () => {
    await ok("builder.startDesign", { siteId });
    const created = await ok("builder.createPage", { siteId, handle: "club", title: "Club room" });
    pageId = created.result.pageId;
    const doc = (await merchant.get(`/api/builder/sites/${siteId}/pages/${pageId}`)).json;
    await ok("builder.addBlock", { siteId, pageId, parentId: doc.tree.children[0].id, type: "text", props: { markdown: PAGE_SECRET } });
    // Live as a public page first, so the gate below is a change a publish makes.
    await ok("builder.publish", { siteId });
    expect((await page("/pages/club")).text).toContain(PAGE_SECRET);

    const home = (await merchant.get(`/api/builder/sites/${siteId}`)).json.pages.find((p: { handle: string }) => p.handle === "home");
    const refusedHome = await act("builder.setPageAccess", { siteId, pageId: home.id, requiresTierId: tierId });
    expect(refusedHome.status).toBe(409);

    const gated = await ok("builder.setPageAccess", { siteId, pageId, requiresTierId: tierId });
    // Undo is the ordinary registry undo, and it puts the page back to public.
    const undo = await merchant.post(`/api/actions/builder.setPageAccess/undo`, { invocationId: gated.invocationId });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect((await merchant.get(`/api/builder/sites/${siteId}/pages/${pageId}`)).json.requiresTierId).toBeNull();
    await ok("builder.setPageAccess", { siteId, pageId, requiresTierId: tierId });
    // A draft change: shoppers still get the live, public page until a publish.
    expect((await page("/pages/club")).text).toContain(PAGE_SECRET);

    // The publish diff names the gate.
    const diff = (await merchant.get(`/api/builder/sites/${siteId}/diff`)).json;
    expect(JSON.stringify(diff)).toContain('"field":"requiresTierId"');
    await ok("builder.publish", { siteId });

    const shown = await page("/pages/club");
    expect(shown.status).toBe(200);
    expect(shown.text).toContain("Club room");
    expect(shown.text).toContain("This page is for Tea Club members.");
    expect(shown.text).not.toContain(PAGE_SECRET);

    const store = await server("/api/store");
    expect(store.json.membersOnlyPages).toEqual([{ handle: "club", requiresTierId: tierId }]);
    expect(store.text).not.toContain(PAGE_SECRET);

    expect((await server("/api/pages/club")).json).toMatchObject({ locked: true, tree: null, membersOnly: true });
    const member_ = await server("/api/pages/club", { key, email: member });
    expect(member_.json.locked).toBe(false);
    expect(JSON.stringify(member_.json.tree)).toContain(PAGE_SECRET);
    expect(member_.headers.get("cache-control")).toBe("private, no-store");

    expect((await page("/llms.txt")).text).toMatch(/Club room\]\([^)]+\/pages\/club\): Members only\./);
    expect((await page("/llms-full.txt")).text ?? "").not.toContain(PAGE_SECRET);
    expect((await page("/sitemap.xml")).text).toContain("/pages/club");
  });

  it("shows the merchant everything in the preview, with a note of what shoppers see", async () => {
    const minted = await merchant.post(`/api/builder/sites/${siteId}/preview-session`, {});
    expect(minted.status, JSON.stringify(minted.json)).toBe(201);
    const previewPath = new URL(minted.json.url).pathname;
    const preview = await shopper.getRaw(`${previewPath}/pages/club`);
    expect(preview.status).toBe(200);
    expect(preview.text).toContain(PAGE_SECRET);
    expect(preview.text).toContain("Shoppers without a Tea Club membership see this page");
    const previewPost = await shopper.getRaw(`${previewPath}/blog/the-house-blend`);
    expect(previewPost.text).toContain(SECRET);
  });

  it("will not delete a tier that still gates content — that would publish it", async () => {
    const refused = await act("memberships.deleteTier", { tierId });
    expect(refused.status).toBe(409);
    expect(refused.json.error.details).toMatchObject({ reason: "tier_gates_content", posts: 1, pages: 1 });
    const [still] = await sql`select id from membership_tiers where id = ${tierId}`;
    expect(still).toBeTruthy();
  });

  it("makes a post public again with one field, and undo puts the gate back", async () => {
    const opened = await ok("blog.updatePost", { postId, requiresTierId: null });
    expect((await page("/blog/the-house-blend")).text).toContain(SECRET);
    const undo = await merchant.post(`/api/actions/blog.updatePost/undo`, { invocationId: opened.invocationId });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect((await page("/blog/the-house-blend")).text).not.toContain(SECRET);
  });
});
