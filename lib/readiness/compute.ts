import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  digitalAssets,
  inventoryLedger,
  licenceKeys,
  locations,
  productDigitalAssets,
  products,
  readinessIssueStates,
  readinessSnapshots,
  shippingRates,
  shippingZones,
  sites,
  taxSettings,
  variants,
  type DbHandle,
} from "../db";
import { defaultWallet } from "../integrations";
import { stripeConfigured } from "../payments";
import { isSesConfigured } from "../email/ses";
import { resolveSender } from "../email/identity";
import { ownSites } from "../tenancy";
import { issueId, productFindings, storeFindings, type ProductFacts, type RuleFinding, type StoreFacts } from "./rules";
import { buildReport, compareIssues } from "./score";
import type { AgentReadinessReport, ReadinessIssue } from "./types";

/**
 * Readiness computation (§9) — reads the real catalog, applies the rules,
 * merges what the merchant already decided.
 *
 * **Issues are recomputed, never stored.** A stored issue is a claim that goes
 * stale the moment someone edits a product, and a merchant who has just fixed a
 * description should not wait for a job to notice. Only their *decisions*
 * (dismissed, resolved, assigned) persist, keyed by a deterministic issue id.
 *
 * Cost matters here as much as correctness: `docs/PRICING.md` §"Margin check"
 * rules out per-product inference outright, so this is a handful of indexed
 * queries and some pure functions.
 */

export type ReadinessFilters = {
  siteId?: number;
  productId?: number;
  categoryId?: number;
  component?: string;
  severity?: string;
  status?: string;
  q?: string;
};

/**
 * Loads every fact the rules need, for one org.
 *
 * Deliberately a fixed number of queries regardless of catalog size — a rule
 * engine that issued a query per product would be the expensive thing this
 * design exists to avoid.
 */
async function loadFacts(orgId: string, filters: ReadinessFilters) {
  const siteRows = await db
    .select()
    .from(sites)
    .where(
      filters.siteId != null
        ? and(ownSites(orgId), eq(sites.id, filters.siteId))
        : ownSites(orgId),
    );
  const siteIds = siteRows.map((s) => s.id);
  if (siteIds.length === 0) return { stores: [] as StoreFacts[], productList: [] as ProductFacts[] };

  const productRows = await db
    .select()
    .from(products)
    .where(
      filters.productId != null
        ? and(inArray(products.siteId, siteIds), eq(products.id, filters.productId))
        : filters.categoryId != null
          ? and(inArray(products.siteId, siteIds), eq(products.categoryId, filters.categoryId))
          : inArray(products.siteId, siteIds),
    );

  const productIds = productRows.map((p) => p.id);
  const variantRows = productIds.length
    ? await db.select().from(variants).where(inArray(variants.productId, productIds))
    : [];

  /**
   * Available-to-sell per variant, as one grouped scan of the ledger rather
   * than a query per variant. The ledger is append-only, so this sum *is* the
   * level — the same definition `lib/commerce/reservations.ts` sells against.
   */
  const variantIds = variantRows.map((v) => v.id);
  const levelRows = variantIds.length
    ? await db
        .select({
          variantId: inventoryLedger.variantId,
          available: sql<string>`coalesce(sum(${inventoryLedger.availableDelta}), 0)`,
          committed: sql<string>`coalesce(sum(${inventoryLedger.committedDelta}), 0)`,
        })
        .from(inventoryLedger)
        .where(inArray(inventoryLedger.variantId, variantIds))
        .groupBy(inventoryLedger.variantId)
    : [];
  const levelByVariant = new Map(
    levelRows.map((r) => [r.variantId, Number(r.available) - Number(r.committed)]),
  );

  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  /**
   * A product that delivers a file or a licence key is digital, and digital
   * goods must not be told to add a shipping weight or a stock location. This
   * is why "is it digital" is derived rather than a flag — the attachments are
   * the truth, and a flag could disagree with them.
   */
  const digitalProductIds = new Set<number>();
  if (productIds.length) {
    const attached = await db
      .select({ productId: productDigitalAssets.productId })
      .from(productDigitalAssets)
      .where(inArray(productDigitalAssets.productId, productIds));
    for (const a of attached) digitalProductIds.add(a.productId);

    const keyed = await db
      .select({ productId: licenceKeys.productId })
      .from(licenceKeys)
      .where(inArray(licenceKeys.productId, productIds));
    for (const k of keyed) digitalProductIds.add(k.productId);
  }

  const productList: ProductFacts[] = productRows.map((p) => {
    const vs = variantsByProduct.get(p.id) ?? [];
    const digital = digitalProductIds.has(p.id);
    return {
      id: p.id,
      siteId: p.siteId,
      categoryId: p.categoryId,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      sku: p.sku,
      images: p.images,
      enabled: p.enabled,
      variants: vs.map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        weightGrams: v.weightGrams,
        // A digital product never needs postage, whatever the variant says.
        requiresShipping: digital ? false : v.requiresShipping,
      })),
      stock: p.stock,
      variantStock: vs.length
        ? vs.reduce((sum, v) => sum + (levelByVariant.get(v.id) ?? 0), 0)
        : null,
    };
  });

  // Store-level configuration, all in one pass per table.
  const zoneRows = siteIds.length
    ? await db.select().from(shippingZones).where(inArray(shippingZones.siteId, siteIds))
    : [];
  const zoneIds = zoneRows.map((z) => z.id);
  const rateRows = zoneIds.length
    ? await db.select().from(shippingRates).where(inArray(shippingRates.zoneId, zoneIds))
    : [];
  const zonesWithRates = new Set(rateRows.filter((r) => r.enabled).map((r) => r.zoneId));

  const taxRows = siteIds.length
    ? await db.select().from(taxSettings).where(inArray(taxSettings.siteId, siteIds))
    : [];
  const locationRows = siteIds.length
    ? await db.select().from(locations).where(inArray(locations.siteId, siteIds))
    : [];

  const orgWallet = await defaultWallet(orgId).catch(() => null);
  const stripeReady = stripeConfigured();

  /**
   * Org-level, like the wallet above: a sending domain belongs to the
   * organization rather than to one storefront, so every store in the org shares
   * the answer. Resolved once rather than per site.
   */
  const sesReady = isSesConfigured();
  const sender = sesReady ? await resolveSender(orgId).catch(() => null) : null;

  const stores: StoreFacts[] = siteRows.map((s) => {
    const mine = productList.filter((p) => p.siteId === s.id);
    const tax = taxRows.find((t) => t.siteId === s.id);
    const myZones = zoneRows.filter((z) => z.siteId === s.id);
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      indexed: s.indexed,
      agentDiscovery: s.agentDiscovery,
      purchasesEnabled: s.purchasesEnabled,
      paymentProviders: s.paymentProviders,
      walletAddress: s.walletAddress,
      orgWalletAddress: orgWallet,
      customDomain: s.customDomain,
      domainStatus: s.domainStatus,
      enabledProductCount: mine.filter((p) => p.enabled).length,
      sellsShippable: mine.some((p) => p.enabled && p.variants.some((v) => v.requiresShipping)),
      shippingZoneCount: myZones.length,
      emptyShippingZoneCount: myZones.filter((z) => !zonesWithRates.has(z.id)).length,
      taxProvider: tax?.provider ?? "none",
      manualTaxRateCount: tax?.manualRates.length ?? 0,
      locationCount: locationRows.filter((l) => l.siteId === s.id).length,
      hasVariantBackedProducts: mine.some((p) => p.variants.length > 0),
      stripeConfigured: stripeReady,
      emailProviderConfigured: sesReady,
      customerEmailReady: sender !== null,
    };
  });

  return { stores, productList };
}

/** Turns a rule finding into a full issue, applying whatever the merchant decided. */
function toIssue(
  finding: RuleFinding,
  state: Map<string, { status: string; assignedTo: string | null; updatedAt: Date }>,
  now: Date,
): ReadinessIssue {
  const id = issueId(finding.code, finding.scope);
  const decided = state.get(id);
  return {
    id,
    severity: finding.severity,
    component: finding.component,
    code: finding.code,
    title: finding.title,
    status: (decided?.status as ReadinessIssue["status"]) ?? "open",
    scope: { ...finding.scope, channelId: null },
    affectedFields: finding.affectedFields,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    expectedImpact: finding.expectedImpact,
    assignedTo: decided?.assignedTo ?? null,
    /**
     * `detectedAt` is the time of this computation, not of first detection.
     * Stated rather than faked: issues are not stored, so there is no record of
     * when one first appeared, and inventing an earlier date would be a
     * fabricated fact about the merchant's own history.
     */
    detectedAt: now.toISOString(),
    updatedAt: (decided?.updatedAt ?? now).toISOString(),
  };
}

export type ComputedReadiness = {
  issues: ReadinessIssue[];
  report: AgentReadinessReport;
};

/**
 * The whole picture for one org, optionally narrowed.
 *
 * Filters narrow which **facts are loaded**, not just which issues are shown,
 * so asking about one product is a small query rather than a full catalog scan
 * that is then filtered down.
 */
export async function computeReadiness(
  orgId: string,
  filters: ReadinessFilters = {},
): Promise<ComputedReadiness> {
  const now = new Date();
  const { stores, productList } = await loadFacts(orgId, filters);

  const findings: RuleFinding[] = [
    // Store rules are skipped when the caller asked about one product — the
    // store's shipping configuration is not that product's problem.
    ...(filters.productId == null ? stores.flatMap(storeFindings) : []),
    ...productList.flatMap(productFindings),
  ];

  const ids = findings.map((f) => issueId(f.code, f.scope));
  const stateRows = ids.length
    ? await db
        .select()
        .from(readinessIssueStates)
        .where(
          and(eq(readinessIssueStates.orgId, orgId), inArray(readinessIssueStates.issueId, ids)),
        )
    : [];
  const stateById = new Map(
    stateRows.map((r) => [
      r.issueId,
      { status: r.status, assignedTo: r.assignedTo, updatedAt: r.updatedAt },
    ]),
  );

  let issues = findings.map((f) => toIssue(f, stateById, now)).sort(compareIssues);

  if (filters.component) issues = issues.filter((i) => i.component === filters.component);
  if (filters.severity) issues = issues.filter((i) => i.severity === filters.severity);
  if (filters.status) issues = issues.filter((i) => i.status === filters.status);
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    issues = issues.filter(
      (i) =>
        i.title.toLowerCase().includes(needle) ||
        i.code.toLowerCase().includes(needle) ||
        i.recommendation.toLowerCase().includes(needle),
    );
  }

  const scope: AgentReadinessReport["scope"] =
    filters.productId != null ? "product" : filters.siteId != null ? "site" : "organization";
  const scopeId = filters.productId ?? filters.siteId ?? null;

  /**
   * The score is always computed from the **unfiltered** issue set for the
   * scope. Filtering to "critical only" must not make a store's score look
   * better — a filter is a view, not a change to the facts.
   */
  const scoringIssues = findings.map((f) => toIssue(f, stateById, now));

  const previous = await previousSnapshot(orgId, scope, scopeId, now);

  /**
   * Every subject the score is averaged over, **including healthy ones**. A
   * product with nothing wrong emits no issues, so it would be invisible here —
   * and a catalog of one broken product would then score the same as one broken
   * product among fifty good ones.
   */
  const subjects = {
    products: productList.map((p) => `p:${p.id}`),
    stores: filters.productId == null ? stores.map((s) => `s:${s.id}`) : [],
  };

  return {
    issues,
    report: buildReport({
      scope,
      scopeId,
      issues: scoringIssues,
      subjects,
      previous,
      computedAt: now,
    }),
  };
}

/** UTC calendar day — the granularity history is kept at. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The most recent snapshot from a day before today, for the trend delta. */
async function previousSnapshot(
  orgId: string,
  scope: AgentReadinessReport["scope"],
  scopeId: number | null,
  now: Date,
): Promise<{ score: number; at: string } | null> {
  const today = dayKey(now);
  const [row] = await db
    .select()
    .from(readinessSnapshots)
    .where(
      and(
        eq(readinessSnapshots.orgId, orgId),
        eq(readinessSnapshots.scope, scope),
        scopeId == null ? isNull(readinessSnapshots.scopeId) : eq(readinessSnapshots.scopeId, scopeId),
        sql`${readinessSnapshots.day} < ${today}`,
      ),
    )
    .orderBy(sql`${readinessSnapshots.day} desc`)
    .limit(1);

  return row ? { score: row.score, at: row.day } : null;
}

/**
 * Records today's score, at most once per scope per day.
 *
 * History is the one part of readiness that must be stored — a score is a
 * function of the catalog as it was, and yesterday's catalog is gone. Overwriting
 * within the same day rather than appending keeps a merchant editing all
 * afternoon from producing a sawtooth instead of a trend.
 */
export async function recordSnapshot(
  handle: DbHandle,
  orgId: string,
  report: AgentReadinessReport,
): Promise<void> {
  const day = dayKey(new Date(report.computedAt));
  const components = Object.fromEntries(report.components.map((c) => [c.key, c.score]));

  await handle
    .insert(readinessSnapshots)
    .values({
      orgId,
      scope: report.scope,
      scopeId: report.scopeId,
      day,
      score: report.score,
      components,
      counts: report.counts,
      computedAt: new Date(report.computedAt),
    })
    .onConflictDoUpdate({
      target: [
        readinessSnapshots.orgId,
        readinessSnapshots.scope,
        readinessSnapshots.scopeId,
        readinessSnapshots.day,
      ],
      set: { score: report.score, components, counts: report.counts, computedAt: new Date() },
    });
}

/**
 * Field-group completeness per product (FR-CM-01).
 *
 * **Only groups this platform has fields for.** The §11 agent-data extension —
 * use cases, FAQs, machine summaries, compatibility, dimensions — is Phase E and
 * does not exist, so those groups are reported in `notMeasured` with the reason
 * rather than scored as empty. Marking every merchant 0/3 on fields they have no
 * way to fill would be a fabricated criticism.
 */
export const COMPLETENESS_GROUPS = [
  { group: "core", label: "Core", fields: ["name", "description", "price", "images"] },
  { group: "identifiers", label: "Identifiers", fields: ["sku", "barcode"] },
  { group: "shipping", label: "Shipping", fields: ["weight", "requiresShipping"] },
  { group: "inventory", label: "Inventory", fields: ["variants", "stock"] },
] as const;

export const NOT_MEASURED_GROUPS = [
  {
    group: "agent_data",
    label: "Agent data",
    fields: ["useCases", "faqs", "machineSummary"],
    reason:
      "Agent-data fields are not available to edit yet, so they are not scored. Scoring them " +
      "would mark every merchant down for something Markii does not offer.",
  },
  {
    group: "compatibility",
    label: "Compatibility",
    fields: ["compatibleWith"],
    reason: "Compatibility fields are not available yet, so they are not scored.",
  },
] as const;

export type GroupState = "complete" | "partial" | "empty";

export function completenessFor(p: ProductFacts): {
  groups: Record<string, { complete: number; total: number; state: GroupState }>;
} {
  const filled: Record<string, boolean[]> = {
    core: [
      Boolean(p.name?.trim()),
      Boolean(p.description?.trim()),
      p.priceCents > 0,
      p.images.length > 0,
    ],
    identifiers: [
      p.variants.length > 0 ? p.variants.every((v) => Boolean(v.sku)) : Boolean(p.sku),
      p.variants.length > 0 && p.variants.some((v) => Boolean(v.barcode)),
    ],
    shipping: (() => {
      const shippable = p.variants.filter((v) => v.requiresShipping);
      // A product that ships nothing is complete on shipping, not empty — it has
      // nothing left to fill in.
      if (shippable.length === 0) return [true, true];
      return [shippable.some((v) => v.weightGrams != null), true];
    })(),
    inventory: [p.variants.length > 0, (p.variantStock ?? p.stock) > 0],
  };

  const groups: Record<string, { complete: number; total: number; state: GroupState }> = {};
  for (const [group, flags] of Object.entries(filled)) {
    const complete = flags.filter(Boolean).length;
    groups[group] = {
      complete,
      total: flags.length,
      state: complete === flags.length ? "complete" : complete === 0 ? "empty" : "partial",
    };
  }
  return { groups };
}

/** Facts for the completeness matrix, reusing the same loader the rules use. */
export async function loadProductFacts(
  orgId: string,
  filters: ReadinessFilters,
): Promise<ProductFacts[]> {
  const { productList } = await loadFacts(orgId, filters);
  return productList;
}

/** Per-product score, for the matrix — the same arithmetic, over that product's issues. */
export function productScore(p: ProductFacts, now = new Date()): { score: number; issueCount: number } {
  const findings = productFindings(p);
  const issues = findings.map((f) => toIssue(f, new Map(), now));
  // One subject: this product. Store-scoped components have no subjects here and
  // score 100, which is correct — a store's payment setup is not this product's.
  const report = buildReport({
    scope: "product",
    scopeId: p.id,
    issues,
    subjects: { products: [`p:${p.id}`], stores: [] },
    computedAt: now,
  });
  return { score: report.score, issueCount: issues.length };
}

/** Digital assets referenced by a product, for surfaces that need the count. */
export async function digitalAssetCount(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(digitalAssets)
    .where(eq(digitalAssets.orgId, orgId));
  return Number(row?.n ?? 0);
}
