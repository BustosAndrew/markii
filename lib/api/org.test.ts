import { describe, expect, it } from "vitest";
import { roleWithin, storesWithin } from "../auth/reach";
import { ASSIGNABLE_STAFF_ROLES, grantableRoles, storesWithinReach } from "./org";
import type { StaffRole } from "./org";

/**
 * The grant pickers (`grantableRoles`, `storesWithinReach`) mirror the server's
 * `lib/auth/reach.ts` so screens never offer a choice the API refuses (D52).
 * A mirror drifts the first time a role's permissions change, so pin it: for
 * every holder, the picker offers exactly the assignable roles `roleWithin`
 * accepts — no more (a rejection waiting to happen), no fewer (a grant nobody
 * can find).
 */
const HOLDERS: StaffRole[] = ["owner", ...ASSIGNABLE_STAFF_ROLES];

describe("grant pickers match the server's rule", () => {
  it.each(HOLDERS)("%s is offered exactly the roles the server accepts", (holder) => {
    const server = ASSIGNABLE_STAFF_ROLES.filter((r) => roleWithin(r, holder));
    expect([...grantableRoles(holder)].sort()).toEqual([...server].sort());
  });

  it("agrees on store reach", () => {
    const cases: [number[] | "all", number[] | "all"][] = [
      ["all", "all"],
      [[1], "all"],
      ["all", [1]],
      [[1], [1, 2]],
      [[1, 3], [1, 2]],
      [[], [1]],
    ];
    for (const [requested, reach] of cases) {
      expect(storesWithinReach(requested, reach)).toBe(storesWithin(requested, reach));
    }
  });
});
