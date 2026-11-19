import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, sites } from "./db";
import { currentStoreScope } from "./store-scope";

/**
 * Tenancy primitives (§16).
 *
 * `docs/BACKEND.md` is blunt about why these exist:
 *
 * > Do not rely on remembering to add a `where orgId = …` clause to thirty
 * > files — one miss is a cross-tenant data leak. **Make the unscoped query
 * > impossible to write.** Structure beats discipline; a code review will not
 * > reliably catch the one route that forgot.
 *
 * Every helper takes `orgId` as a **required, non-optional** first argument.
 * There is deliberately no unscoped variant to import by mistake, and no default
 * that would quietly widen scope when a caller passes `undefined`.
 *
 * Only `sites` carries `orgId`. Categories, products, orders, and traffic reach
 * their org through `siteId`, so `siteScope` is the single choke point — one
 * place to get tenancy wrong, and one place to fix it.
 */

export type OrgId = string;

/** Matches nothing. Used where an empty allow-list must not degrade to "allow all". */
const MATCH_NOTHING = sql`false`;

/**
 * Restricts a `siteId` column to sites the org owns.
 *
 * A subquery rather than a join, so it composes with the existing `and(...)`
 * filters in every list route without rewriting their shape. Postgres executes
 * it as a semi-join against `sites_org_idx`.
 */
export function siteScope(orgId: OrgId, siteIdColumn: AnyPgColumn): SQL {
  return narrowToCallerStores(
    inArray(siteIdColumn, db.select({ id: sites.id }).from(sites).where(eq(sites.orgId, orgId))),
    siteIdColumn,
  );
}

/** Restricts the `sites` table itself. */
export function ownSites(orgId: OrgId): SQL {
  return narrowToCallerStores(eq(sites.orgId, orgId), sites.id);
}

/**
 * Intersects an org filter with the current caller's stores
 * (`lib/store-scope.ts`). Inside `orgHandler` or `invokeAction` that is the
 * caller's `storeIds`; outside both it is `"all"` and the filter is unchanged.
 * So a store-scoped member is narrowed by every existing org check — list,
 * single-item lookup and action alike — without each one opting in.
 */
function narrowToCallerStores(orgFilter: SQL, siteIdColumn: AnyPgColumn): SQL {
  const scope = currentStoreScope();
  if (scope === "all") return orgFilter;
  if (scope.length === 0) return MATCH_NOTHING;
  return and(orgFilter, inArray(siteIdColumn, scope))!;
}

/**
 * Narrows an org filter to the subset of stores a staff member is scoped to
 * (`staff.storeIds`).
 *
 * Per-store scoping is *additional* to org scoping, never a replacement: the
 * two are intersected, so a `storeIds` array listing another org's site ids
 * grants nothing.
 */
export function siteScopeForStaff(
  orgId: OrgId,
  storeIds: number[] | "all",
  siteIdColumn: AnyPgColumn,
): SQL {
  const orgFilter = siteScope(orgId, siteIdColumn);
  if (storeIds === "all") return orgFilter;
  if (storeIds.length === 0) return MATCH_NOTHING;
  return and(orgFilter, inArray(siteIdColumn, storeIds))!;
}

/** The same intersection, for queries against `sites` directly. */
export function ownSitesForStaff(orgId: OrgId, storeIds: number[] | "all"): SQL {
  if (storeIds === "all") return ownSites(orgId);
  if (storeIds.length === 0) return MATCH_NOTHING;
  return and(ownSites(orgId), inArray(sites.id, storeIds))!;
}
