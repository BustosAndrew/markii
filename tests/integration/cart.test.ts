import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, demoStore, sql, trackCart } from "./helpers";

/**
 * Cart behaviour (§18.4) against the seeded demo store.
 *
 * The rule under test throughout is the one `docs/BACKEND.md` §4 calls
 * non-negotiable: money is recomputed server-side and a client-supplied amount
 * is never trusted.
 */
describe("storefront cart", () => {
  const client = new Client();
  const cleanup = new Cleanup();
  let slug: string;
  let p1: any;
  let p2: any;
  let otherProductId: number;
  let token: string;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;

  beforeAll(async () => {
    const store = await demoStore();
    slug = store.slug;
    [p1, p2] = store.products;

    const [other] = await sql`select p.id from products p
      join sites s on s.id = p.site_id
      where s.id <> ${store.site.id} limit 1`;
    otherProductId = other.id;

    const created = await client.post(cart(), {});
    token = created.json.token;
    await trackCart(cleanup, token);
  });

  afterAll(async () => {
    await cleanup.run();
  });

  it("creates an empty cart with an unguessable token", async () => {
    const r = await client.post(cart(), {});
    await trackCart(cleanup, r.json.token);

    expect(r.status).toBe(201);
    // 256 bits of base64url. The token is the shopper's only credential and
    // protects an email and a shipping address, so it is never the row id.
    expect(r.json.token.length).toBeGreaterThanOrEqual(40);
    expect(r.json.lines).toHaveLength(0);
    expect(r.json.subtotalMinor).toBe(0);
  });

  it("adds a line and prices it from the catalogue", async () => {
    const r = await client.patch(cart(`/${token}`), {
      add: { productId: p1.id, quantity: 2 },
    });
    expect(r.status).toBe(200);
    expect(r.json.subtotalMinor).toBe(p1.price_cents * 2);
  });

  it("raises quantity instead of creating a second line for the same item", async () => {
    const r = await client.patch(cart(`/${token}`), {
      add: { productId: p1.id, quantity: 1 },
    });
    expect(r.json.lines).toHaveLength(1);
    expect(r.json.lines[0].quantity).toBe(3);
    expect(r.json.subtotalMinor).toBe(p1.price_cents * 3);
  });

  it("ignores client-supplied totals entirely", async () => {
    const r = await client.patch(cart(`/${token}`), {
      add: { productId: p2.id, quantity: 1 },
      subtotalMinor: 1,
      totalMinor: 1,
      unitPriceMinor: 1,
    });
    expect(r.json.subtotalMinor).toBe(p1.price_cents * 3 + p2.price_cents);
  });

  it("does not resolve a cart token on a different store", async () => {
    const [other] = await sql`select slug from sites where slug <> ${slug} limit 1`;
    const r = await client.get(`/_sites/${other.slug}/api/cart/${token}`);
    expect(r.status).toBe(404);
  });

  it("refuses to add another store's product", async () => {
    const r = await client.patch(cart(`/${token}`), {
      add: { productId: otherProductId, quantity: 1 },
    });
    expect(r.status).toBe(404);
  });

  it("discloses a price change and charges the new price", async () => {
    const raised = p1.price_cents + 500;
    await sql`update products set price_cents = ${raised} where id = ${p1.id}`;
    try {
      const r = await client.get(cart(`/${token}`));
      const line = r.json.lines.find((l: any) => l.productId === p1.id);

      const changed = line.issues.find((i: any) => i.code === "price_changed");
      expect(changed).toBeDefined();
      expect(changed.wasMinor).toBe(p1.price_cents);
      expect(changed.nowMinor).toBe(raised);
      // Disclosure is not a discount: the cart charges the current price.
      expect(line.unitPriceMinor).toBe(raised);
    } finally {
      await sql`update products set price_cents = ${p1.price_cents} where id = ${p1.id}`;
    }
  });

  it("keeps a disabled product visible and marked, not silently dropped", async () => {
    await sql`update products set enabled = false where id = ${p1.id}`;
    try {
      const r = await client.get(cart(`/${token}`));
      const line = r.json.lines.find((l: any) => l.productId === p1.id);

      expect(line).toBeDefined();
      expect(line.issues.some((i: any) => i.code === "unavailable")).toBe(true);
      expect(line.lineTotalMinor).toBe(0);
      // Blocking: a cart with an unavailable item cannot check out.
      expect(r.json.issues.some((i: any) => i.code === "unavailable")).toBe(true);
    } finally {
      await sql`update products set enabled = true where id = ${p1.id}`;
    }
  });

  it("removes a line when its quantity is set to zero", async () => {
    const before = await client.get(cart(`/${token}`));
    const lineId = before.json.lines.find((l: any) => l.productId === p2.id).id;

    const r = await client.patch(cart(`/${token}`), {
      setQuantity: { lineId, quantity: 0 },
    });
    expect(r.json.lines.find((l: any) => l.productId === p2.id)).toBeUndefined();
  });

  it("does not clear the shipping address when only a rate is set", async () => {
    // The regression: `input.shippingAddress ?? null` coerced *absent* into
    // *cleared*, so picking a rate wiped the address it was quoted against.
    await client.patch(cart(`/${token}`), {
      shippingAddress: { line1: "1 Test St", city: "Denver", province: "CO", country: "US" },
    });
    await client.patch(cart(`/${token}`), { shippingRateId: "some-rate" });

    const r = await client.get(cart(`/${token}`));
    expect(r.json.shippingAddress).not.toBeNull();
    expect(r.json.shippingAddress.city).toBe("Denver");
  });
});
