import { ApiError } from "../api";
import type { StaffRole } from "../db";
import type { StoreIds } from "../store-scope";
import { permissionsForRole } from "./permissions";

/**
 * What a caller may hand out, and what they may manage (D52).
 *
 * Role decides **what** someone can do; `storeIds` decides **where**. Both
 * have to hold for anything a caller creates or changes on someone else's
 * behalf, or the two limits are only as strong as the loosest door that
 * issues credentials:
 *
 * - **A grant never exceeds its granter.** A token, an invitation or a role
 *   change carries a role whose permissions are a subset of the caller's, and
 *   stores within the caller's. Before this, a `developer` (who holds
 *   `tokens.manage`) could mint an `administrator` token and so gain billing,
 *   payouts and staff management; and a member scoped to one store could mint
 *   an all-stores token or invite an all-stores administrator.
 * - **You manage only those within your reach.** A store-scoped administrator
 *   may edit, disable, remove or revoke members and tokens whose stores are
 *   within their own — not an all-stores administrator, whom they could
 *   otherwise lock out.
 * - **Org-wide settings need org-wide reach.** Billing, payout rails,
 *   integrations, sending domains, the org profile and creating a store change
 *   every store at once, so a member scoped to some stores cannot make them,
 *   whatever their role.
 *
 * Refusals are `403` with their own codes, never `404`: the caller can see the
 * thing (it is in their org), they just may not do this to it.
 */

/** Every permission of `requested` is also held by `holder`. */
export function roleWithin(requested: StaffRole, holder: StaffRole): boolean {
  const held = new Set<string>(permissionsForRole(holder));
  return permissionsForRole(requested).every((p) => held.has(p));
}

/** `requested` reaches no store that `reach` does not. */
export function storesWithin(requested: StoreIds, reach: StoreIds): boolean {
  if (reach === "all") return true;
  if (requested === "all") return false;
  const allowed = new Set(reach);
  return requested.every((id) => allowed.has(id));
}

/** Refuses a grant — token, invitation, role or scope change — wider than the caller's own. */
export function assertGrantWithin(
  grant: { role?: StaffRole; storeIds?: StoreIds },
  caller: { role: StaffRole; storeIds: StoreIds },
): void {
  if (grant.role && !roleWithin(grant.role, caller.role)) {
    throw new ApiError(
      "BEYOND_YOUR_ACCESS",
      403,
      `Your role (${caller.role}) cannot grant the ${grant.role} role — it carries permissions you do not hold.`,
      { reason: "role", requested: grant.role, yourRole: caller.role },
    );
  }
  if (grant.storeIds !== undefined && !storesWithin(grant.storeIds, caller.storeIds)) {
    throw new ApiError(
      "BEYOND_YOUR_ACCESS",
      403,
      "You can only grant access to stores you have access to yourself.",
      { reason: "stores", requested: grant.storeIds, yourStores: caller.storeIds },
    );
  }
}

/** Refuses managing a member or token whose stores reach beyond the caller's. */
export function assertManages(target: { storeIds: StoreIds }, callerStores: StoreIds, what: string): void {
  if (!storesWithin(target.storeIds, callerStores)) {
    throw new ApiError(
      "BEYOND_YOUR_ACCESS",
      403,
      `This ${what} has access to stores you do not, so only someone with that access can change it.`,
      { reason: "stores" },
    );
  }
}

/** Refuses an org-wide change from a caller scoped to some stores. */
export function assertOrgWideReach(storeIds: StoreIds, what: string): void {
  if (storeIds !== "all") {
    throw new ApiError(
      "STORE_SCOPED",
      403,
      `${what} applies to every store in the organization, and your access is limited to some stores.`,
      { reason: "org_wide" },
    );
  }
}
