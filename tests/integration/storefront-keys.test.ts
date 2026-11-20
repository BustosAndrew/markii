import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Storefront secret keys (D53, 2026-11-20) — members-only products sold from
 * an exported store. The export's own sign-in says who the shopper is; its
 * server sends a store key and the shopper's email; Markii resolves that to
 * the store's customer and every membership gate follows.
 *
 * The refusals matter as much as the sale: a member is unlocked, a non-member
 * is not, a wrong or revoked key is a `401` rather than a quiet guest, a key
 * from a browser is refused, a key for one store opens nothing on another, and
 * the plaintext never reaches the audit log.
 */
describe("storefront secret keys", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let otherSlug: string;
  let gated: any;
  let key: string;
  let keyId: number;
  const stamp = Date.now();
  const member = `member-${stamp}@example.com`;
  const stranger = `stranger-${stamp}@example.com`;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);

  /** What an export's server sends: no cookies, no Origin. */
  async function server(path: string, opts: { key?: string; email?: string; origin?: string; method?: string; body?: unknown; site?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    if (opts.email) headers["markii-shopper-email"] = opts.email;
    if (opts.origin) headers.origin = opts.origin;
    const res = await fetch(`${BASE_URL}/_sites/${opts.site ?? slug}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const addGated = (opts: { key?: string; email?: string; origin?: string } = {}) =>
    server("/api/cart", { ...opts, method: "POST", body: { productId: gated.id, quantity: 1 } });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "sfkeys");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "sfkeys", { orgId });
    siteId = store.site.id;
    slug = store.slug;
    gated = store.products[0];
    otherSlug = (await createTestStore(cleanup, "sfkeys2", { orgId })).slug;

    const [tier] = await sql`insert into membership_tiers (site_id, name, handle)
      values (${siteId}, 'Insiders', ${`insiders-${stamp}`}) returning id`;
    await sql`update products set requires_tier_id = ${tier.id} where id = ${gated.id}`;
    const [customer] = await sql`insert into customers (site_id, email) values (${siteId}, ${member}) returning id`;
    await sql`insert into customer_memberships (customer_id, tier_id, source) values (${customer.id}, ${tier.id}, 'manual')`;

    const created = await act("storefront.createKey", { siteId, label: "Export" });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    key = created.json.result.key;
    keyId = created.json.result.id;
    expect(key.startsWith("mksk_live_")).toBe(true);

    // The audit row holds a placeholder, never the key.
    const [row] = await sql`select result from action_invocations where id = ${created.json.invocationId}`;
    expect(JSON.stringify(row.result)).not.toContain(key);
  }, 180_000);

  // Customers, tiers and memberships go with the site (`ON DELETE CASCADE`).
  afterAll(async () => cleanup.run(), 120_000);

  it("lists the key by prefix, never by value", async () => {
    const res = await merchant.get(`/api/sites/${siteId}/storefront-keys`);
    expect(res.status).toBe(200);
    expect(res.json.keys).toHaveLength(1);
    expect(key.startsWith(res.json.keys[0].prefix)).toBe(true);
    expect(JSON.stringify(res.json)).not.toContain(key);
  });

  it("the read API names the tier a product needs", async () => {
    const res = await server(`/api/products/${gated.slug}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ membersOnly: true, requiresTier: { name: "Insiders" } });
  });

  it("a guest and a non-member are refused the gated product; a member is sold it", async () => {
    expect((await addGated()).status).toBe(409);
    expect((await addGated({ key, email: stranger })).status).toBe(409);
    const sold = await addGated({ key, email: member });
    expect(sold.status, JSON.stringify(sold.json)).toBe(201);
    const [cart] = await sql`select id from carts where token = ${sold.json.token}`;
    if (cart) cleanup.cartIds.push(cart.id);
  });

  it("answers the member's own memberships, and needs a named shopper to", async () => {
    const mine = await server("/api/account/memberships", { key, email: member });
    expect(mine.status).toBe(200);
    expect(mine.json.memberships.map((m: any) => m.tier.name)).toEqual(["Insiders"]);
    expect((await server("/api/account/memberships", { key })).status).toBe(401);
  });

  it("refuses a wrong key, a key from a browser, a malformed shopper and another store's key — never a quiet guest", async () => {
    expect((await addGated({ key: `${key}x`, email: member })).status).toBe(401);
    expect((await addGated({ key, email: member, origin: "https://shop.example.com" })).status).toBe(403);
    expect((await addGated({ key, email: "not-an-email" })).status).toBe(400);
    expect((await server("/api/account/memberships", { key, email: member, site: otherSlug })).status).toBe(401);
  });

  it("stops working the moment it is revoked", async () => {
    const revoked = await act("storefront.revokeKey", { siteId, keyId });
    expect(revoked.status, JSON.stringify(revoked.json)).toBe(200);
    expect((await addGated({ key, email: member })).status).toBe(401);
  });
});
