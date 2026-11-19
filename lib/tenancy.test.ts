import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { products } from "./db";
import { currentStoreScope, withStoreScope } from "./store-scope";
import { ownSites, siteScope } from "./tenancy";

/**
 * Per-store scoping rides on the org helpers (`lib/store-scope.ts`), so every
 * existing org check narrows without opting in. These pin the SQL each helper
 * builds in and out of a scope — the integration suite proves a scoped member
 * is actually refused.
 */
const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(q);

describe("store scope on the tenancy helpers", () => {
  it("leaves the org filter alone outside any scope", () => {
    expect(currentStoreScope()).toBe("all");
    const q = render(ownSites("org_1"));
    expect(q.params).toEqual(["org_1"]);
  });

  it('leaves it alone for a caller scoped to "all"', () => {
    const q = withStoreScope("all", () => render(siteScope("org_1", products.siteId)));
    expect(q.params).toEqual(["org_1"]);
  });

  it("intersects with the caller's stores", () => {
    const own = withStoreScope([3, 7], () => render(ownSites("org_1")));
    expect(own.params).toEqual(["org_1", 3, 7]);
    expect(own.sql).toContain(`"sites"."id" in`);

    const scoped = withStoreScope([3], () => render(siteScope("org_1", products.siteId)));
    expect(scoped.params).toEqual(["org_1", 3]);
    expect(scoped.sql).toContain(`"products"."site_id" in`);
  });

  it("matches nothing for an empty list, never everything", () => {
    const q = withStoreScope([], () => render(ownSites("org_1")));
    expect(q.sql).toBe("false");
  });

  it("survives an await, so a handler's later queries are still scoped", async () => {
    const seen = await withStoreScope([5], async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentStoreScope();
    });
    expect(seen).toEqual([5]);
    expect(currentStoreScope()).toBe("all");
  });

  it("an inner scope replaces the outer one — invokeAction's own resolution wins", () => {
    const inner = withStoreScope("all", () => withStoreScope([2], () => currentStoreScope()));
    expect(inner).toEqual([2]);
  });
});
