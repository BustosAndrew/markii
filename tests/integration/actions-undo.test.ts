import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Action undo end to end (§22).
 *
 * The reconstruction is unit-tested in `lib/actions/inverse.test.ts` and needs
 * no database. What only a real request can show is the part that spans the
 * route, the registry, and the row: that the value actually goes back, that the
 * audit log links both directions, that a second undo is refused, and that a
 * change made in between is refused rather than silently discarded.
 *
 * Every bug this repo has found in Phase C lived in that span rather than in
 * the arithmetic (`tests/README.md`), and undo is almost entirely span.
 */
describe("action undo", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: any;
  let products: any[];
  let variantId: number;

  const undo = (actionId: string, invocationId: string) =>
    merchant.post(`/api/actions/${actionId}/undo`, { invocationId });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "undo");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "undo", { orgId });
    site = store.site;
    products = store.products;

    // One variant to price-edit. The catalog actions work on variants, and the
    // fixture products have none.
    const [variant] = await sql`insert into variants
      (product_id, title, option_values, price_minor, position)
      values (${products[0].id}, 'Default', ${sql.json({})}, 1500, 0)
      returning *`;
    variantId = variant.id;
  });

  afterAll(async () => {
    await sql`delete from action_invocations where org_id = ${orgId}`;
    await cleanup.run();
  });

  it("puts the previous value back and links both invocations", async () => {
    const change = await merchant.invoke("catalog.updateVariant", {
      variantId,
      priceMinor: 2500,
    });
    expect(change.status).toBe(200);

    const [afterChange] = await sql`select price_minor from variants where id = ${variantId}`;
    expect(Number(afterChange.price_minor)).toBe(2500);

    const res = await undo("catalog.updateVariant", change.json.invocationId);
    expect(res.status).toBe(200);
    expect(res.json.undoOf).toBe(change.json.invocationId);
    expect(res.json.undoneWith).toBe("catalog.updateVariant");

    // Asserted against the row, not the response that claimed to write it.
    const [restored] = await sql`select price_minor from variants where id = ${variantId}`;
    expect(Number(restored.price_minor)).toBe(1500);

    // The audit log reads in both directions (migration 0034).
    const [original] = await sql`
      select undone_by_invocation_id from action_invocations where id = ${change.json.invocationId}`;
    expect(original.undone_by_invocation_id).toBe(res.json.invocationId);

    const [undoRow] = await sql`
      select undo_of_invocation_id, action_id, ok
      from action_invocations where id = ${res.json.invocationId}`;
    expect(undoRow.undo_of_invocation_id).toBe(change.json.invocationId);
    expect(undoRow.ok).toBe(true);
  });

  it("refuses a second undo of the same invocation", async () => {
    const change = await merchant.invoke("catalog.updateVariant", { variantId, priceMinor: 3300 });
    const first = await undo("catalog.updateVariant", change.json.invocationId);
    expect(first.status).toBe(200);

    const second = await undo("catalog.updateVariant", change.json.invocationId);
    expect(second.status).toBe(409);
    expect(second.json.error.details.undo).toBe("already_undone");

    // The refusal must not have moved anything — the price is still the undone one.
    const [row] = await sql`select price_minor from variants where id = ${variantId}`;
    expect(Number(row.price_minor)).toBe(1500);
  });

  it("refuses when the field has changed since, rather than discarding the change", async () => {
    const change = await merchant.invoke("catalog.updateVariant", { variantId, priceMinor: 4000 });

    // Somebody else edits the same field.
    await merchant.invoke("catalog.updateVariant", { variantId, priceMinor: 4200 });

    const res = await undo("catalog.updateVariant", change.json.invocationId);
    expect(res.status).toBe(409);
    expect(res.json.error.details.undo).toBe("conflict");
    expect(res.json.error.details.conflicts[0].path).toBe("priceMinor");

    // The later edit survives. This is the whole point of the check: undoing
    // here would silently reset the price to 1500 and lose the 4200.
    const [row] = await sql`select price_minor from variants where id = ${variantId}`;
    expect(Number(row.price_minor)).toBe(4200);

    // And the conflict left no undo in the audit log to reconcile later.
    const [{ n }] = await sql`
      select count(*)::int as n from action_invocations
      where undo_of_invocation_id = ${change.json.invocationId}`;
    expect(n).toBe(0);

    await merchant.invoke("catalog.updateVariant", { variantId, priceMinor: 1500 });
  });

  it("restores a collection's previous products in their previous order", async () => {
    const created = await merchant.invoke("catalog.createCollection", {
      siteId: site.id,
      title: "Undo Collection",
      handle: `undo-collection-${Date.now()}`,
    });
    expect(created.status).toBe(200);
    const collectionId = created.json.result.id;

    const ordered = [products[2].id, products[0].id, products[1].id];
    await merchant.invoke("catalog.setCollectionProducts", { collectionId, productIds: ordered });

    const change = await merchant.invoke("catalog.setCollectionProducts", {
      collectionId,
      productIds: [products[1].id],
    });
    expect(change.status).toBe(200);

    const res = await undo("catalog.setCollectionProducts", change.json.invocationId);
    expect(res.status).toBe(200);

    /**
     * Order is the merchandising for a manual collection, so the sequence has
     * to come back too — not just the set. This is the assertion that would
     * have failed before the action was changed to record its previous
     * membership: the diff held `before: null`, so there was nothing to restore
     * and the collection would have been emptied instead.
     */
    const rows = await sql`
      select product_id from collection_products
      where collection_id = ${collectionId} order by position`;
    expect(rows.map((r: any) => Number(r.product_id))).toEqual(ordered);

    await sql`delete from collections where id = ${collectionId}`;
  });

  it("undoes a stock adjustment even after stock has moved since", async () => {
    const [location] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Undo Location', false) returning *`;

    /**
     * Opening stock, so undoing the mistake below does not drive the level
     * negative — the variant's policy is `deny`, which refuses that, correctly.
     * Undo holds no privileges of its own, so the action's own guards still
     * apply to it.
     */
    await merchant.invoke("inventory.adjust", {
      variantId,
      locationId: location.id,
      delta: 50,
      reason: "opening count",
    });

    const change = await merchant.invoke("inventory.adjust", {
      variantId,
      locationId: location.id,
      delta: 40,
      reason: "miscount",
    });
    expect(change.status).toBe(200);

    // Something else happens to the level in between.
    await merchant.invoke("inventory.adjust", {
      variantId,
      locationId: location.id,
      delta: -6,
      reason: "sold",
    });

    /**
     * A strict conflict check would refuse here, and it would be wrong to. The
     * level is a sum over an append-only ledger, so the opposite entry is the
     * correct correction whatever else happened — and the moment stock moves is
     * exactly when a merchant reaches for undo.
     */
    const res = await undo("inventory.adjust", change.json.invocationId);
    expect(res.status).toBe(200);

    // 50 opening − 6 sold. The mistaken +40 and its inverse cancel, and the
    // sale that happened in between survives untouched.
    const [{ available }] = await sql`
      select coalesce(sum(available_delta), 0)::int as available
      from inventory_ledger where variant_id = ${variantId} and location_id = ${location.id}`;
    expect(available).toBe(44);

    await sql`delete from inventory_ledger where location_id = ${location.id}`;
    await sql`delete from locations where id = ${location.id}`;
  });

  it("refuses an action that declares no inverse", async () => {
    const change = await merchant.invoke("customers.create", {
      siteId: site.id,
      email: `undo-${Date.now()}@example.com`,
    });
    expect(change.status).toBe(200);
    expect(change.json.undoable).toBe(false);

    const res = await undo("customers.create", change.json.invocationId);
    expect(res.status).toBe(409);
    expect(res.json.error.details.undo).toBe("no_inverse");

    await sql`delete from customers where id = ${change.json.result.id}`;
  });

  it("refuses when the path names a different action than the record", async () => {
    const change = await merchant.invoke("catalog.updateVariant", { variantId, priceMinor: 1700 });

    const res = await undo("inventory.adjust", change.json.invocationId);
    expect(res.status).toBe(400);

    // Nothing ran under the wrong name.
    const [row] = await sql`select price_minor from variants where id = ${variantId}`;
    expect(Number(row.price_minor)).toBe(1700);

    await undo("catalog.updateVariant", change.json.invocationId);
  });

  it("does not reach another org's invocation", async () => {
    const other = new Client();
    const { email } = await signUpMerchant(other, "undo-other");
    cleanup.merchantEmails.push(email);

    const change = await merchant.invoke("catalog.updateVariant", { variantId, priceMinor: 1800 });

    /**
     * The other merchant's session must be live before this proves anything —
     * a dropped cookie would 401 and read as a refusal (`helpers.ts`). And the
     * status is pinned at 404 rather than "any 4xx": a 403 would confirm the
     * invocation id exists, which is itself a leak.
     */
    expect((await other.get("/api/me")).status).toBe(200);

    const res = await other.post(`/api/actions/catalog.updateVariant/undo`, {
      invocationId: change.json.invocationId,
    });
    expect(res.status).toBe(404);

    const [row] = await sql`select price_minor from variants where id = ${variantId}`;
    expect(Number(row.price_minor)).toBe(1800);

    await undo("catalog.updateVariant", change.json.invocationId);
  });

  it("reports undoability in the registry listing and on each invocation", async () => {
    const registry = await merchant.get("/api/actions");
    expect(registry.status).toBe(200);

    const byId = new Map(registry.json.items.map((a: any) => [a.id, a]));
    expect((byId.get("catalog.updateVariant") as any).undoable).toBe(true);
    // Not a claim any more — `defineAction` refuses a definition where the flag
    // and the inverse disagree, and this action has no way back.
    expect((byId.get("customers.update") as any).undoable).toBe(false);
  });
});
