import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Per-store scoping (`staff.storeIds`, `api_tokens.store_ids`) — closed
 * 2026-11-19.
 *
 * Before then it was honoured only where a list route remembered
 * `siteScopeForStaff`. No registry action and no single-item route checked
 * it, so a member scoped to store A could read, edit and delete store B's
 * catalog, discounts and pages — and several lists (discounts, customers,
 * shipping, collections) showed every store anyway. The fix rides on the org
 * helpers themselves (`lib/store-scope.ts`), so it is tested here from the
 * outside: one org, two stores, a credential scoped to the first.
 *
 * A token is the fixture because it resolves through the same code as a
 * staff member — `orgHandler` reads `storeIds` from the auth context and
 * `invokeAction` re-reads it from the row — and needs no second mailbox.
 * Every refusal has a **positive control on store A** with the same
 * credential, so a dead token cannot pass these by being refused for the
 * wrong reason (the lesson in CLAUDE.md about `refused()` and 4xx).
 */
describe("per-store scoping", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let bearer: string;
  let tokenId: string;
  let siteA: number;
  let siteB: number;
  let productA: number;
  let productB: number;
  let categoryB: number;
  let discountB: number;

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "storescope");
    cleanup.merchantEmails.push(email);

    const stamp = Date.now();
    const a = await merchant.post("/api/sites", { name: `Scope A ${stamp}`, slug: `scope-a-${stamp}` });
    const b = await merchant.post("/api/sites", { name: `Scope B ${stamp}`, slug: `scope-b-${stamp}` });
    siteA = a.json.id ?? a.json.site?.id;
    siteB = b.json.id ?? b.json.site?.id;

    productA = (await merchant.post("/api/products", { siteId: siteA, name: "In A", priceCents: 1000 })).json.id;
    productB = (await merchant.post("/api/products", { siteId: siteB, name: "In B", priceCents: 1000 })).json.id;
    categoryB = (await merchant.post("/api/categories", { siteId: siteB, name: "Cat B" })).json.id;
    const discount = await merchant.invoke("discounts.create", {
      siteId: siteB,
      code: `SCOPEB${stamp}`,
      title: "B only",
      type: "percentage",
      percentageBps: 1000,
    });
    discountB = discount.json.result.id;

    const created = await merchant.post("/api/org/tokens", {
      label: "store A only",
      role: "administrator",
      storeIds: [siteA],
    });
    expect(created.status).toBe(201);
    bearer = created.json.token;
    tokenId = created.json.id;
  }, 180_000);

  afterAll(async () => {
    await cleanup.run();
  }, 120_000);

  it("reads its own store's product, and not the other store's", async () => {
    expect((await call("GET", `/api/products/${productA}`)).status).toBe(200);
    expect((await call("GET", `/api/products/${productB}`)).status).toBe(404);
  });

  it("does not list the other store's discounts", async () => {
    const r = await call("GET", "/api/discounts");
    expect(r.status).toBe(200);
    expect((r.json.items as { id: number }[]).map((d) => d.id)).not.toContain(discountB);
  });

  it("cannot edit the other store's product through the registry", async () => {
    const own = await call("POST", "/api/actions/catalog.updateProduct", { productId: productA, name: "In A, edited" });
    expect(own.status).toBe(200);

    const other = await call("POST", "/api/actions/catalog.updateProduct", { productId: productB, name: "Hijacked" });
    expect(other.status).toBe(404);
    const [row] = await sql`select name from products where id = ${productB}`;
    expect(row.name).toBe("In B");
  });

  it("cannot move its own product into the other store", async () => {
    const r = await call("POST", "/api/actions/catalog.updateProduct", { productId: productA, siteId: siteB });
    expect(r.status).toBe(404);
    const [row] = await sql`select site_id from products where id = ${productA}`;
    expect(row.site_id).toBe(siteA);
  });

  it("cannot edit or delete the other store's category through the v1 routes", async () => {
    expect((await call("PATCH", `/api/categories/${categoryB}`, { name: "Hijacked" })).status).toBe(404);
    expect((await call("DELETE", `/api/categories/${categoryB}`)).status).toBe(404);
    const [row] = await sql`select name from categories where id = ${categoryB}`;
    expect(row.name).toBe("Cat B");
  });

  it("cannot change the other store's discount", async () => {
    const r = await call("POST", "/api/actions/discounts.update", { discountId: discountB, percentageBps: 9000 });
    expect(r.status).toBe(404);
    const [row] = await sql`select percentage_bps from discounts where id = ${discountB}`;
    expect(row.percentage_bps).toBe(1000);
  });

  it("follows a token narrowed after it was issued, on its very next call", async () => {
    // Narrow the token after it was issued: the next invocation must see it.
    await sql`update api_tokens set store_ids = '[]'::jsonb where id = ${tokenId}`;
    try {
      const r = await call("POST", "/api/actions/catalog.updateProduct", { productId: productA, name: "Unreachable" });
      expect(r.status).toBe(404);
    } finally {
      await sql`update api_tokens set store_ids = ${sql.json([siteA])} where id = ${tokenId}`;
    }
  });

  /**
   * Role says what, stores say where — and org-wide changes need every store
   * (`lib/auth/reach.ts`). The scoped token here is an `administrator`, so
   * each refusal below is the reach, not the role: the exact code is pinned
   * because a `FORBIDDEN` would mean the wrong check fired.
   */
  describe("org-wide changes and grants", () => {
    const tokenFrom = async (as: string, body: unknown) => {
      const res = await fetch(`${BASE_URL}/api/org/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };

    it("refuses an org-wide action from a store-scoped administrator", async () => {
      const r = await call("POST", "/api/actions/billing.setCancellation", { cancelAtPeriodEnd: true });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("STORE_SCOPED");
    });

    it("refuses org-wide routes: the org profile and creating a store", async () => {
      const org = await call("PATCH", "/api/org", { name: "Renamed by a scoped admin" });
      expect(org.status).toBe(403);
      expect(org.json.error.code).toBe("STORE_SCOPED");
      const site = await call("POST", "/api/sites", { name: "Sneaky", slug: `sneaky-${Date.now()}` });
      expect(site.status).toBe(403);
      expect(site.json.error.code).toBe("STORE_SCOPED");
    });

    it("cannot mint a token wider than itself, and defaults to its own stores", async () => {
      const wide = await tokenFrom(bearer, { label: "wider", role: "viewer", storeIds: "all" });
      expect(wide.status).toBe(403);
      expect(wide.json.error.code).toBe("BEYOND_YOUR_ACCESS");

      const other = await tokenFrom(bearer, { label: "other store", role: "viewer", storeIds: [siteB] });
      expect(other.status).toBe(403);

      const narrow = await tokenFrom(bearer, { label: "inherits", role: "viewer" });
      expect(narrow.status).toBe(201);
      expect(narrow.json.storeIds).toEqual([siteA]);
    });

    it("a developer cannot mint an administrator token", async () => {
      const dev = await merchant.post("/api/org/tokens", { label: "dev", role: "developer" });
      expect(dev.status).toBe(201);
      const escalated = await tokenFrom(dev.json.token, { label: "escalated", role: "administrator" });
      expect(escalated.status).toBe(403);
      expect(escalated.json.error.details.reason).toBe("role");
      // Its own role or narrower is fine.
      expect((await tokenFrom(dev.json.token, { label: "dev child", role: "viewer" })).status).toBe(201);
    });

    it("invites within its own stores, and cannot manage a member with wider reach", async () => {
      const stamp = Date.now();
      const wide = await call("POST", "/api/org/staff/invite", { email: `wide-${stamp}@example.com`, role: "viewer", storeIds: "all" });
      expect(wide.status).toBe(403);
      expect(wide.json.error.code).toBe("BEYOND_YOUR_ACCESS");

      const own = await call("POST", "/api/org/staff/invite", { email: `own-${stamp}@example.com`, role: "viewer" });
      expect(own.status).toBe(201);
      expect(own.json.storeIds).toEqual([siteA]);
      // …and may not then widen them.
      const widened = await call("PATCH", `/api/org/staff/${own.json.id}`, { storeIds: "all" });
      expect(widened.status).toBe(403);

      const allStores = await merchant.post("/api/org/staff/invite", { email: `all-${stamp}@example.com`, role: "viewer" });
      expect(allStores.status).toBe(201);
      const touched = await call("PATCH", `/api/org/staff/${allStores.json.id}`, { status: "disabled" });
      expect(touched.status).toBe(403);
      expect(touched.json.error.code).toBe("BEYOND_YOUR_ACCESS");
      expect((await call("DELETE", `/api/org/staff/${allStores.json.id}`)).status).toBe(403);
    });

    it("cannot revoke a token that reaches stores it does not", async () => {
      const wide = await merchant.post("/api/org/tokens", { label: "all stores", role: "viewer" });
      expect(wide.status).toBe(201);
      const r = await call("DELETE", `/api/org/tokens/${wide.json.id}`);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("BEYOND_YOUR_ACCESS");
      const [row] = await sql`select revoked_at from api_tokens where id = ${wide.json.id}`;
      expect(row.revoked_at).toBeNull();
    });
  });
});
