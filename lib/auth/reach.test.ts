import { describe, expect, it } from "vitest";
import { allActions } from "../actions/registry";
import "../actions/index";
import { ApiError } from "../api";
import { assertGrantWithin, assertManages, assertOrgWideReach, roleWithin, storesWithin } from "./reach";

/** D52: role says what, `storeIds` says where, and a grant never exceeds its granter on either. */
describe("reach", () => {
  it("lets a role grant itself and anything narrower, never wider", () => {
    expect(roleWithin("administrator", "administrator")).toBe(true);
    expect(roleWithin("viewer", "developer")).toBe(true);
    expect(roleWithin("developer", "developer")).toBe(true);
    // The hole: a developer holds tokens.manage and could mint an administrator token.
    expect(roleWithin("administrator", "developer")).toBe(false);
    expect(roleWithin("catalog_manager", "developer")).toBe(false);
    expect(roleWithin("commerce_manager", "catalog_manager")).toBe(false);
  });

  it("keeps stores within the caller's own", () => {
    expect(storesWithin("all", "all")).toBe(true);
    expect(storesWithin([1, 2], "all")).toBe(true);
    expect(storesWithin([1], [1, 2])).toBe(true);
    expect(storesWithin([], [1])).toBe(true);
    expect(storesWithin("all", [1, 2])).toBe(false);
    expect(storesWithin([1, 3], [1, 2])).toBe(false);
  });

  it("refuses with the code a screen can act on", () => {
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return e instanceof ApiError ? [e.code, e.status] : e;
      }
      return null;
    };
    expect(code(() => assertGrantWithin({ role: "administrator" }, { role: "developer", storeIds: "all" }))).toEqual(["BEYOND_YOUR_ACCESS", 403]);
    expect(code(() => assertGrantWithin({ storeIds: "all" }, { role: "administrator", storeIds: [1] }))).toEqual(["BEYOND_YOUR_ACCESS", 403]);
    expect(code(() => assertGrantWithin({ role: "viewer", storeIds: [1] }, { role: "administrator", storeIds: [1] }))).toBeNull();
    expect(code(() => assertManages({ storeIds: "all" }, [1], "member"))).toEqual(["BEYOND_YOUR_ACCESS", 403]);
    expect(code(() => assertManages({ storeIds: [1] }, [1, 2], "member"))).toBeNull();
    expect(code(() => assertOrgWideReach([1], "Billing"))).toEqual(["STORE_SCOPED", 403]);
    expect(code(() => assertOrgWideReach("all", "Billing"))).toBeNull();
  });

  /**
   * The org-wide set, pinned by module: everything in billing, payments,
   * integrations and email changes every store at once, so a new action there
   * that forgets the flag fails here rather than shipping as a store-scoped
   * member's way into the whole org.
   */
  it("marks every billing, payments, integrations and email action org-wide", () => {
    const orgModules = /^(billing|payments|integrations|email)\./;
    const missing = allActions()
      .filter((a) => orgModules.test(a.id) && !a.orgWide)
      .map((a) => a.id);
    expect(missing).toEqual([]);
    const elsewhere = allActions()
      .filter((a) => !orgModules.test(a.id) && a.orgWide)
      .map((a) => a.id);
    expect(elsewhere).toEqual([]);
  });
});
