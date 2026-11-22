import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Storefront redirects (`docs/BUILDER.md` §15 step 12) against a real
 * database and dev server. The rules are unit-tested; what only this can show
 * is the wiring: that a rule fires from the catch-all route and from the
 * routes whose thing has gone, that it never fires where a page exists, and
 * that a paused store sends no one anywhere.
 */
describe("storefront redirects", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let productSlug: string;

  const act = (id: string, input: unknown, dryRun = false) => merchant.post(`/api/actions/${id}${dryRun ? "?dryRun=1" : ""}`, input);
  const ok = async (id: string, input: unknown) => {
    const res = await act(id, input);
    expect(res.status, `${id}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  };
  /** One storefront request, redirects not followed — the response itself is the assertion. */
  const visit = async (path: string) => {
    const res = await fetch(`${BASE_URL}/_sites/${slug}${path}`, { redirect: "manual", headers: { "x-forwarded-for": "203.0.113.77" } });
    await res.arrayBuffer();
    return { status: res.status, location: res.headers.get("location") };
  };
  const list = async (q = "") => (await merchant.get(`/api/sites/${siteId}/redirects${q}`)).json;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "redirects");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "redirects", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    productSlug = store.products[0].slug;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("sends an old platform's link on, however it was pasted, from a path no route claims", async () => {
    expect((await visit("/products/green-tea")).status).toBe(404);
    const created = await ok("redirects.create", { siteId, from: "https://old-shop.example/Products/Green-Tea/?variant=3", to: `/p/${productSlug}` });
    expect(created.result).toMatchObject({ from: "/products/green-tea", to: `/p/${productSlug}`, permanent: true });

    const hit = await visit("/products/green-tea");
    expect(hit.status).toBe(308);
    expect(hit.location).toMatch(new RegExp(`/p/${productSlug}$`));
    expect(hit.location).toMatch(/^https?:\/\//);
    // Matched as normalised: case and a trailing slash make no difference.
    expect((await visit("/PRODUCTS/green-tea/")).status).toBe(308);
  });

  it("fires where a product, collection or page has gone — and never where one exists", async () => {
    await ok("redirects.create", { siteId, from: "/p/retired-blend", to: "/collections", permanent: false });
    const gone = await visit("/p/retired-blend");
    expect(gone.status).toBe(307);
    expect(gone.location).toMatch(/\/collections$/);

    await ok("redirects.create", { siteId, from: "/collections/old-teas", to: "https://blog.example.com/teas" });
    expect(await visit("/collections/old-teas")).toEqual({ status: 308, location: "https://blog.example.com/teas" });

    await ok("redirects.create", { siteId, from: "/pages/about-us", to: "/" });
    expect((await visit("/pages/about-us")).status).toBe(308);

    // A rule on a live product's own path is stored, and does nothing while the product is there.
    await ok("redirects.create", { siteId, from: `/p/${productSlug}`, to: "/collections" });
    expect((await visit(`/p/${productSlug}`)).status).toBe(200);
  });

  it("refuses rules that could never fire, loops, unsafe targets and duplicates", async () => {
    const reserved = await act("redirects.create", { siteId, from: "/cart", to: "/" });
    expect(reserved.status).toBe(400);
    expect(reserved.json.error.details.field).toBe("from");

    const unsafe = await act("redirects.create", { siteId, from: "/old", to: "javascript:alert(1)" });
    expect(unsafe.status).toBe(400);
    expect(unsafe.json.error.details.field).toBe("to");

    await ok("redirects.create", { siteId, from: "/loop-a", to: "/loop-b" });
    const loop = await act("redirects.create", { siteId, from: "/loop-b", to: "/LOOP-A/" });
    expect(loop.status).toBe(409);
    expect(loop.json.error.details.reason).toBe("loop");

    const dup = await act("redirects.create", { siteId, from: "/Products/Green-Tea", to: "/" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.reason).toBe("from_taken");
  });

  it("updates and deletes through the registry, and undo brings a deleted rule back", async () => {
    const [rule] = (await list("?q=retired-blend")).items;
    expect(rule).toMatchObject({ from: "/p/retired-blend", permanent: false });

    const updated = await ok("redirects.update", { siteId, redirectId: rule.id, to: `/p/${productSlug}`, permanent: true });
    expect(updated.result).toMatchObject({ to: `/p/${productSlug}`, permanent: true });
    expect((await visit("/p/retired-blend")).status).toBe(308);

    const deleted = await ok("redirects.delete", { siteId, redirectId: rule.id });
    expect((await visit("/p/retired-blend")).status).toBe(404);

    const undo = await merchant.post(`/api/actions/redirects.delete/undo`, { invocationId: deleted.invocationId });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect((await visit("/p/retired-blend")).status).toBe(308);
  });

  it("imports a list, reporting bad rows — and a dry run writes nothing", async () => {
    const before = (await list()).total;
    const body = {
      siteId,
      redirects: [
        { from: "/products/oolong", to: `/p/${productSlug}` },
        { from: "/products/sencha", to: "/collections" },
        { from: "/products/oolong", to: "/" },
        { from: "/account", to: "/" },
        { from: "/products/green-tea", to: "/" },
      ],
    };
    const preview = await act("redirects.import", body, true);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json.result).toMatchObject({ created: 2, replaced: 0 });
    expect(preview.json.result.skipped.map((s: { row: number }) => s.row)).toEqual([2, 3, 4]);
    expect((await list()).total).toBe(before);

    const done = await ok("redirects.import", body);
    expect(done.result).toMatchObject({ created: 2, total: before + 2 });
    expect((await visit("/products/sencha")).status).toBe(308);

    const replaced = await ok("redirects.import", { siteId, redirects: [{ from: "/products/green-tea", to: "/collections" }], replace: true });
    expect(replaced.result).toMatchObject({ created: 0, replaced: 1, skipped: [] });
    expect((await visit("/products/green-tea")).location).toMatch(/\/collections$/);
  });

  it("sends no one anywhere from a paused store", async () => {
    await sql`update sites set status = 'paused' where id = ${siteId}`;
    try {
      expect((await visit("/products/green-tea")).status).toBe(404);
    } finally {
      await sql`update sites set status = 'live' where id = ${siteId}`;
    }
  });
});
