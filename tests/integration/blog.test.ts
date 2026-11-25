import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The blog (`docs/BUILDER.md` §15 step 12) against a real database and dev
 * server. What only this shows: that a post is invisible until published and
 * visible exactly when its date has passed, that every surface agents and
 * crawlers read — the page's JSON-LD, the feed, the sitemap, llms.txt,
 * llms-full.txt — picks it up, and that the preview shows a draft no shopper can.
 */
describe("blog", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let postId: number;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const ok = async (id: string, input: unknown) => {
    const res = await act(id, input);
    expect(res.status, `${id}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  };
  const page = (path: string) => shopper.getRaw(`/_sites/${slug}${path}`);
  const visit = async (path: string) => {
    const res = await fetch(`${BASE_URL}/_sites/${slug}${path}`, { redirect: "manual", headers: { "x-forwarded-for": "203.0.113.78" } });
    await res.arrayBuffer();
    return { status: res.status, location: res.headers.get("location") };
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "blog");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "blog", { orgId });
    siteId = store.site.id;
    slug = store.slug;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("writes a draft no shopper can see, and refuses to publish it empty", async () => {
    const created = await ok("blog.createPost", { siteId, title: "Spring Harvest: First Flush!" });
    expect(created.result).toMatchObject({ handle: "spring-harvest-first-flush", status: "draft", publishedAt: null });
    postId = created.result.postId;

    expect((await page("/blog/spring-harvest-first-flush")).status).toBe(404);
    expect((await page("/blog")).text).toContain("No posts yet");

    const empty = await act("blog.publishPost", { postId });
    expect(empty.status).toBe(409);
    expect(empty.json.error.details.reason).toBe("checks_failed");

    const again = await ok("blog.createPost", { siteId, title: "Spring harvest: first flush" });
    expect(again.result.handle).toBe("spring-harvest-first-flush-2");
    await ok("blog.deletePost", { postId: again.result.postId });
  });

  it("publishes one post — its page, JSON-LD, index, feed and sitemap all carry it", async () => {
    await ok("blog.updatePost", {
      postId,
      body: "# The leaves\n\nPicked in **March**. <script>alert(1)</script>\n\n![A tea garden](https://cdn.test/garden.jpg)\n\nSee [the range](/collections).",
      author: "Mei",
      excerpt: "The first teas of the year are in.",
    });
    const published = await ok("blog.publishPost", { postId });
    expect(published.result.status).toBe("published");

    const post = await page("/blog/spring-harvest-first-flush");
    expect(post.status).toBe(200);
    expect(post.text).toContain('<h1 class="sf-title">Spring Harvest: First Flush!</h1>');
    expect(post.text).toContain("<h2>The leaves</h2>");
    expect(post.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(post.text).not.toContain("<script>alert(1)");
    expect(post.text).toContain('"@type":"BlogPosting"');
    expect(post.text).toContain('"name":"Mei"');
    expect(post.text).toContain('loading="eager"');

    const index = await page("/blog");
    expect(index.text).toContain("The first teas of the year are in.");
    expect(index.text).toContain('"@type":"Blog"');

    const feed = await page("/blog/feed.xml");
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    expect(feed.text).toContain("<title>Spring Harvest: First Flush!</title>");
    expect(feed.text).toContain("<dc:creator>Mei</dc:creator>");

    expect((await page("/sitemap.xml")).text).toContain("/blog/spring-harvest-first-flush</loc>");
    const llms = (await page("/llms.txt")).text;
    expect(llms).toContain("## Blog");
    expect(llms).toContain("/blog/feed.xml");
    const full = (await page("/llms-full.txt")).text;
    expect(full).toContain("## Spring Harvest: First Flush!");
    expect(full).toContain("## The leaves");
    expect(full).toMatch(/\[the range\]\(https?:\/\/[^)]+\/collections\)/);
  });

  it("schedules by date alone: a future post is hidden, and appears once its time has passed", async () => {
    const later = await ok("blog.createPost", { siteId, title: "Coming soon", body: "Not yet." });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await ok("blog.publishPost", { postId: later.result.postId, at: future });
    expect(scheduled.result.status).toBe("scheduled");
    expect((await page("/blog/coming-soon")).status).toBe(404);
    expect((await page("/blog/feed.xml")).text).not.toContain("Coming soon");
    const listed = (await merchant.get(`/api/sites/${siteId}/blog/posts?status=scheduled`)).json;
    expect(listed.items.map((p: { handle: string }) => p.handle)).toEqual(["coming-soon"]);

    // Moving the date into the past is all it takes — nothing runs on a clock.
    await ok("blog.publishPost", { postId: later.result.postId, at: new Date(Date.now() - 60_000).toISOString() });
    expect((await page("/blog/coming-soon")).status).toBe(200);
  });

  it("shows drafts in the builder preview, labelled, and nowhere else", async () => {
    const draft = await ok("blog.createPost", { siteId, title: "Secret draft", body: "Only the merchant sees this." });
    await ok("builder.startDesign", { siteId });
    const minted = await merchant.post(`/api/builder/sites/${siteId}/preview-session`, {});
    expect(minted.status, JSON.stringify(minted.json)).toBe(201);
    const previewPath = new URL(minted.json.url).pathname;

    const preview = await shopper.getRaw(`${previewPath}/blog/secret-draft`);
    expect(preview.status).toBe(200);
    expect(preview.text).toContain("Draft — not published");
    expect(preview.text).not.toContain('"@type":"BlogPosting"');
    expect((await shopper.getRaw(`${previewPath}/blog`)).text).toContain("Secret draft");
    expect((await page("/blog")).text).not.toContain("Secret draft");
    await ok("blog.deletePost", { postId: draft.result.postId });
  });

  it("keeps a live post's old address working when its handle changes", async () => {
    await ok("blog.updatePost", { postId, handle: "first-flush" });
    const hit = await visit("/blog/spring-harvest-first-flush");
    expect(hit.status).toBe(308);
    expect(hit.location).toMatch(/\/blog\/first-flush$/);
    expect((await visit("/blog/first-flush")).status).toBe(200);
  });

  it("takes a post down and back, and deletes only what is not live", async () => {
    const refused = await act("blog.deletePost", { postId });
    expect(refused.status).toBe(409);

    const down = await ok("blog.unpublishPost", { postId });
    expect((await page("/blog/first-flush")).status).toBe(404);
    const undo = await merchant.post(`/api/actions/blog.unpublishPost/undo`, { invocationId: down.invocationId });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect((await page("/blog/first-flush")).status).toBe(200);

    const detail = (await merchant.get(`/api/sites/${siteId}/blog/posts/${postId}`)).json;
    expect(detail).toMatchObject({ handle: "first-flush", status: "published", author: "Mei" });
    expect(detail.body).toContain("# The leaves");
  });

  it("serves live posts on the read API — never a draft or a scheduled one — and lists them in a block", async () => {
    const draft = await ok("blog.createPost", { siteId, title: "Unwritten", body: "Draft text." });
    const soon = await ok("blog.createPost", { siteId, title: "Next week", body: "Not yet." });
    await ok("blog.publishPost", { postId: soon.result.postId, at: new Date(Date.now() + 86_400_000).toISOString() });

    const list = await page("/api/blog/posts");
    expect(list.status).toBe(200);
    expect(list.headers.get("access-control-allow-origin")).toBe("*");
    const body = JSON.parse(list.text);
    const handles = body.posts.map((p: { handle: string }) => p.handle);
    expect(handles).toEqual(expect.arrayContaining(["first-flush", "coming-soon"]));
    expect(handles).not.toContain("unwritten");
    expect(handles).not.toContain("next-week");
    expect(body).toMatchObject({ page: 1, pages: 1, total: 2 });
    expect(body.posts[0]).not.toHaveProperty("id");

    const one = JSON.parse((await page("/api/blog/posts?limit=1")).text);
    expect(one.posts).toHaveLength(1);
    expect(one).toMatchObject({ pages: 2, total: 2 });
    expect(JSON.parse((await page("/api/blog/posts?page=9")).text)).toMatchObject({ posts: [], page: 9, pages: 1 });

    const detail = await page("/api/blog/posts/first-flush");
    expect(detail.status).toBe(200);
    const post = JSON.parse(detail.text);
    expect(post).toMatchObject({ handle: "first-flush", author: "Mei" });
    expect(post.url).toMatch(/\/blog\/first-flush$/);
    expect(post.body).toContain("# The leaves");
    expect(typeof post.description).toBe("string");
    // A draft and a scheduled post are the same 404 as a handle that never existed.
    for (const handle of ["unwritten", "next-week", "never-was"]) {
      expect((await page(`/api/blog/posts/${handle}`)).status, handle).toBe(404);
    }

    // The latest-posts block draws the same live list on a published page.
    await ok("builder.startDesign", { siteId });
    const homeId = (await merchant.get(`/api/builder/sites/${siteId}`)).json.pages[0].id;
    const section = (await merchant.get(`/api/builder/sites/${siteId}/pages/${homeId}`)).json.tree.children[0];
    await ok("builder.addBlock", { siteId, pageId: homeId, parentId: section.id, type: "blogPosts", props: { limit: 5 } });
    await ok("builder.publish", { siteId });
    const home = (await page("/")).text;
    expect(home).toContain("/blog/first-flush");
    expect(home).toContain("/blog/coming-soon");
    expect(home).not.toContain("/blog/next-week");

    await ok("blog.deletePost", { postId: draft.result.postId });
    await ok("blog.unpublishPost", { postId: soon.result.postId });
    await ok("blog.deletePost", { postId: soon.result.postId });
  });
});
