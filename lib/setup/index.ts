import "server-only";

import { inArray } from "drizzle-orm";
import { roleHasPermission } from "../auth/permissions";
import type { AuthContext } from "../auth/session";
import { accountStanding } from "../billing/standing";
import { db, sites, taxSettings } from "../db";
import { getIntegration } from "../integrations";
import { computeReadiness, loadFacts } from "../readiness/compute";
import { setupChecklist, type SetupChecklist } from "./checklist";

export type { SetupChecklist, SetupStep, StoreSetup } from "./checklist";

/**
 * Loads the setup checklist for the person asking (§28).
 *
 * **Their reach, not the org's.** A staff member limited to two stores sees
 * those two — the same rule the agents' reads follow — and `canAct` is
 * answered from their role, so a `viewer` is told who can do a step rather
 * than sent to a page that will refuse them.
 *
 * One readiness load serves both the store facts and the product findings.
 * Every read is a database read: no Stripe or DNS call, so a slow provider
 * cannot make the checklist fail — the same rule readiness keeps.
 */
export async function setupStatus(auth: Pick<AuthContext, "org" | "role" | "storeIds">): Promise<SetupChecklist> {
  const orgId = auth.org.id;
  const facts = await loadFacts(orgId, {});

  const reachable = (id: number) => auth.storeIds === "all" || auth.storeIds.includes(id);
  const storeFacts = facts.stores.filter((s) => reachable(s.id));
  const siteIds = storeFacts.map((s) => s.id);

  const [slugRows, taxRows, stripeRow, readiness] = await Promise.all([
    siteIds.length
      ? db.select({ id: sites.id, slug: sites.slug }).from(sites).where(inArray(sites.id, siteIds))
      : [],
    siteIds.length
      ? db
          .select({ siteId: taxSettings.siteId })
          .from(taxSettings)
          .where(inArray(taxSettings.siteId, siteIds))
      : [],
    getIntegration(orgId, "stripe").catch(() => null),
    computeReadiness(orgId, {}, facts),
  ]);

  const slugById = new Map(slugRows.map((r) => [r.id, r.slug]));
  const taxConfigured = new Set(taxRows.map((r) => r.siteId));
  /** Read as `integrationStatus` reads it — `chargesEnabled` is the only honest card gate. */
  const stripe = {
    chargesEnabled: stripeRow?.config.chargesEnabled === "true",
    requirementsDue: (stripeRow?.config.requirementsDue ?? "").split(",").filter(Boolean),
  };

  /**
   * Products with an open finding that costs score — `opportunity` is a
   * suggestion, and counting it would leave "fill catalog gaps" undone for a
   * catalog with nothing wrong. Dismissed and resolved findings are the
   * merchant's decisions and are respected, as on the Health page.
   */
  const productsBySite = new Map<number, Set<number>>();
  for (const issue of readiness.issues) {
    const { siteId, productId } = issue.scope;
    if (siteId == null || productId == null) continue;
    if (issue.status !== "open" && issue.status !== "assigned") continue;
    if (issue.severity === "opportunity") continue;
    const set = productsBySite.get(siteId) ?? new Set<number>();
    set.add(productId);
    productsBySite.set(siteId, set);
  }

  return setupChecklist({
    stores: storeFacts.map((s) => ({
      ...s,
      slug: slugById.get(s.id) ?? String(s.id),
      taxConfigured: taxConfigured.has(s.id),
    })),
    standing: accountStanding(auth.org),
    stripe,
    productsWithIssues: new Map([...productsBySite].map(([id, set]) => [id, set.size])),
    can: (permission) => roleHasPermission(auth.role, permission),
  });
}
